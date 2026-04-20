const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { FileInventory } = require('../db/models');
const { NODE_ID, ADMIN_KEY, JWT_SECRET } = require('../config');

// ============ SIGNED URL ENDPOINT ============

router.get('/', async (req, res) => {
    try {
        // 1. AUTHENTICATION CHECK
        // This ensures only the Main Instance (which holds your ADMIN_KEY) can request URLs
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];

        if (!token || token !== ADMIN_KEY) {
            console.error(`[SIGNED-URL] ❌ Unauthorized access attempt from ${req.ip}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { hash } = req.query;
        if (!hash) return res.status(400).json({ error: 'hash required' });

        // 2. Verify file exists and is active on this node
        const file = await FileInventory.findOne({ hash, status: 'active' });
        if (!file) {
            return res.status(404).json({ error: 'File not found on this storage node' });
        }

        // 3. Set Expiration (25 minutes)
        const expiresAt = Date.now() + (25 * 60 * 1000); 

        // 4. Generate HMAC Signature
        // Uses JWT_SECRET to sign the link so the /api/download route can verify it
        const signature = crypto.createHmac('sha256', JWT_SECRET)
            .update(`${hash}${expiresAt}`)
            .digest('hex');

        // 5. Build full URL
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const signedUrl = `${protocol}://${host}/api/download/${hash}?expires=${expiresAt}&signature=${signature}`;

        console.log(`[SIGNED-URL] 🔗 Link generated for: ${file.filename}`);

        res.json({
            success: true,
            signed_url: signedUrl,
            expires_at: expiresAt,
            filename: file.filename,
            size: file.size
        });

    } catch (err) {
        console.error(`[SIGNED-URL] ❌ Error: ${err.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
