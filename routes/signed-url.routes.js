const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { FileInventory } = require('../db/models');
const { ADMIN_KEY, JWT_SECRET } = require('../config');

// ============ SIGNED URL ENDPOINT ============

router.get('/', async (req, res) => {
    try {
        // 1. AUTHENTICATION CHECK
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

        // 3. Set Expiration (2 hours for playback)
        const expiresIn = 7200; 
        const expiresAt = Date.now() + (expiresIn * 1000);

        // 4. Generate PROXIED Download Link
        // Instead of R2 doing the streaming, our server will now proxy the file.
        // This ensures it's served as a standard HTTP 200 (no partial content) 
        // to avoid the browser range-request flood.
        console.log(`[SIGNED-URL] 🚀 Generating proxied link for: ${file.filename}`);
        
        const host = req.get('host');
        const protocol = req.protocol;
        
        // We sign the hash and expiration to prevent URL tampering
        const signature = crypto.createHmac('sha256', JWT_SECRET)
            .update(`${hash}${expiresAt}`)
            .digest('hex');

        // Construct the URL back to our /api/download route
        // We add proxy=true to force our server to stream it directly
        const proxiedUrl = `${protocol}://${host}/api/download/${hash}?expires=${expiresAt}&signature=${signature}&proxy=true`;

        res.json({
            success: true,
            signed_url: proxiedUrl,
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
