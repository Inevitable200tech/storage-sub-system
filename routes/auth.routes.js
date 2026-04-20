const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { NODE_ID, ADMIN_KEY, JWT_SECRET } = require('../config');

// ============ AUTH ENDPOINT ============

router.post('/login', async (req, res) => {
    try {
        const { admin_key } = req.body;
        
        if (!admin_key) return res.status(400).json({ error: 'Admin key required' });
        if (admin_key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
        
        const token = jwt.sign({ node_id: NODE_ID }, JWT_SECRET, { expiresIn: '24h' });
        console.log(`[LOGIN] ✅ Success for ${NODE_ID}`);
        res.json({ success: true, token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
