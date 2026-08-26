// Minimal in-memory job queue with concurrency limiting so the VPS is
// never overloaded by too many parallel agent/video jobs at once.
// Intentionally dependency-free (no Redis) to keep resource usage low.
const logger = require('../utils/logger');
const { getResourceStatus } = require('./systemMonitor.service');

class JobQueue {
  constructor(name, concurrency = 2) {
    this.name = name;
    this.baseConcurrency = concurrency;
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
    this.throttled = false;
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, n);
  }

  // Halves concurrency (minimum 1) while RAM is high, and restores it once
  // usage is back to normal - satisfies "jika resource terlalu tinggi,
  // kurangi concurrency" rather than only queueing/waiting.
  applyResourcePressure(isHigh) {
    if (isHigh && !this.throttled) {
      this.throttled = true;
      this.concurrency = Math.max(1, Math.floor(this.baseConcurrency / 2));
      logger.log('system', 'warn', `Queue "${this.name}" concurrency reduced to ${this.concurrency} (RAM pressure)`);
    } else if (!isHigh && this.throttled) {
      this.throttled = false;
      this.concurrency = this.baseConcurrency;
      logger.log('system', 'info', `Queue "${this.name}" concurrency restored to ${this.concurrency}`);
    }
  }

  push(jobFn, meta = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ jobFn, meta, resolve, reject });
      this._tick();
    });
  }

  async _tick() {
    if (this.running >= this.concurrency || this.pending.length === 0) return;

    // Resource-aware throttling: if RAM usage is above the soft limit,
    // hold off starting new jobs until it comes back down.
    const status = getResourceStatus();
    if (status.ramUsedMb > status.ramSoftLimitMb) {
      logger.log('system', 'warn', `Queue "${this.name}" throttled: RAM above soft limit`, status);
      setTimeout(() => this._tick(), 3000);
      return;
    }

    const job = this.pending.shift();
    this.running++;

    try {
      const result = await job.jobFn();
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      this.running--;
      this._tick();
    }
  }

  status() {
    return { name: this.name, running: this.running, queued: this.pending.length, concurrency: this.concurrency };
  }
}

// Two separate queues: heavier video jobs get their own low-concurrency
// lane so they never starve lighter text-only agent jobs.
const videoQueue = new JobQueue('video', parseInt(process.env.MAX_VIDEO_CONCURRENCY || '2', 10));
const agentQueue = new JobQueue('agent', parseInt(process.env.MAX_AGENT_CONCURRENCY || '3', 10));

// TikTok publish queue - kept separate and low-concurrency (default 1) to
// respect TikTok's own rate limits and avoid competing with video
// rendering for resources. Purely additive: does not touch videoQueue/agentQueue.
const tiktokQueue = new JobQueue('tiktok', parseInt(process.env.MAX_TIKTOK_CONCURRENCY || '1', 10));

// TikTok Shop shoppable video publish queue - separate from tiktokQueue
// above since TikTok Shop Partner API is a distinct service with its own
// rate limits; keeping them independent avoids one flow starving the other.
const tiktokShopQueue = new JobQueue('tiktok_shop', parseInt(process.env.MAX_TIKTOK_SHOP_CONCURRENCY || '1', 10));

// Periodically checks resource pressure and adjusts queues' effective
// concurrency accordingly, independent of whether jobs are currently
// waiting (so it reacts proactively, not just when _tick() runs).
setInterval(() => {
  const status = getResourceStatus();
  const isHigh = status.ramUsedMb > status.ramSoftLimitMb;
  videoQueue.applyResourcePressure(isHigh);
  agentQueue.applyResourcePressure(isHigh);
}, 10000);

module.exports = { videoQueue, agentQueue, tiktokQueue, tiktokShopQueue, JobQueue };
