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

        // 3. Set Expiration (1 hour for playback)
        const expiresIn = 3600; 
        const expiresAt = Date.now() + (expiresIn * 1000);

        // 4. Generate DIRECT R2 Signed URL (CRITICAL for speed)
        // This bypasses the /api/download redirect and lets the browser hit R2 directly
        console.log(`[SIGNED-URL] 🚀 Generating direct R2 link for: ${file.filename}`);
        
        const { getR2Client } = require('../services/r2');
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

        const r2Client = await getR2Client(file.bucket_name);
        const command = new GetObjectCommand({
            Bucket: file.bucket_name,
            Key: file.object_key
        });

        const directSignedUrl = await getSignedUrl(r2Client, command, { expiresIn });

        res.json({
            success: true,
            signed_url: directSignedUrl,
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
