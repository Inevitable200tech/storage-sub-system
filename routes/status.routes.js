const express = require('express');
const router = express.Router();
const { NODE_ID } = require('../config');
const { getTotalStats } = require('../services/storage');

// ============ STATUS ENDPOINTS ============

router.get('/status', async (req, res) => {
    try {
        const stats = await getTotalStats();
        res.json({ success: true, node_id: NODE_ID, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/space', async (req, res) => {
    try {
        const stats = await getTotalStats();
        res.json({ success: true, node_id: NODE_ID, ...stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/health', (req, res) => {
    res.json({ status: 'ok', node_id: NODE_ID, uptime: process.uptime() });
});

module.exports = router;
