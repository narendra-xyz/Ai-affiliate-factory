// Reads OS-level resource usage (RAM/CPU/storage) so the dashboard and
// the job queues can react when the VPS is under load.
const os = require('os');
const checkDiskSpace = require('check-disk-space').default;

const RAM_SOFT_LIMIT_MB = parseInt(process.env.RAM_SOFT_LIMIT_MB || '4096', 10);
const RAM_HARD_LIMIT_MB = parseInt(process.env.RAM_HARD_LIMIT_MB || '6144', 10);

function getResourceStatus() {
  const totalMb = os.totalmem() / 1024 / 1024;
  const freeMb = os.freemem() / 1024 / 1024;
  const usedMb = totalMb - freeMb;
  const loadAvg = os.loadavg(); // [1min, 5min, 15min]
  const cpuCount = os.cpus().length;

  return {
    ramUsedMb: Math.round(usedMb),
    ramTotalMb: Math.round(totalMb),
    ramSoftLimitMb: RAM_SOFT_LIMIT_MB,
    ramHardLimitMb: RAM_HARD_LIMIT_MB,
    cpuLoad1m: loadAvg[0],
    cpuCount,
    cpuLoadPercent: Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100)),
  };
}

async function getStorageStatus(mountPath = '/') {
  try {
    const info = await checkDiskSpace(mountPath);
    return {
      freeGb: +(info.free / 1024 / 1024 / 1024).toFixed(1),
      totalGb: +(info.size / 1024 / 1024 / 1024).toFixed(1),
      usedPercent: +(((info.size - info.free) / info.size) * 100).toFixed(1),
    };
  } catch (err) {
    return { freeGb: null, totalGb: null, usedPercent: null, error: err.message };
  }
}

// Checks whether n8n is reachable. Backend must keep working normally
// even if this fails - callers only use this to display a status badge.
async function getN8nStatus() {
  const baseUrl = process.env.N8N_BASE_URL;
  if (!baseUrl) return { connected: false, reason: 'N8N_BASE_URL not configured' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/healthz`, { signal: controller.signal });
    clearTimeout(timeout);
    return { connected: res.ok, statusCode: res.status };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

module.exports = { getResourceStatus, getStorageStatus, getN8nStatus };
