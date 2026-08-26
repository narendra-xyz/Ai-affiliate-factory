const express = require('express');
const { getResourceStatus, getStorageStatus, getN8nStatus } = require('../services/systemMonitor.service');
const { videoQueue, agentQueue } = require('../services/queue.service');
const { getIntegrationStatus } = require('../services/integrationRegistry.service');

const router = express.Router();

router.get('/status', async (req, res) => {
  res.json({
    resources: getResourceStatus(),
    storage: await getStorageStatus('/'),
    queues: { video: videoQueue.status(), agent: agentQueue.status() },
    n8n: await getN8nStatus(),
  });
});

// Honest status of every external integration - "Not Configured" is a
// first-class, expected state, never hidden or faked.
router.get('/integrations', (req, res) => {
  res.json(getIntegrationStatus());
});

module.exports = router;
