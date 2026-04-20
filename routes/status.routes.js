const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { NODE_ID } = require('../config');
const { getTotalStats } = require('../services/storage');
const { FileInventory } = require('../db/models');
const { getR2Client } = require('../services/r2');
const { verifyToken } = require('../middleware/auth');
const mediaService = require('../services/media');

// ============ STATUS ENDPOINTS ============

router.get('/api/status', async (req, res) => {
    try {
        const stats = await getTotalStats();
        res.json({ success: true, node_id: NODE_ID, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/space', async (req, res) => {
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

// ============ ADMIN: REPROCESS THUMBNAILS ============

router.post('/api/admin/reprocess-thumbnails', verifyToken, async (req, res) => {
    try {
        const { limit = 10 } = req.body; // Process in small batches to avoid timeout
        
        // Find files that don't have a thumbnail yet
        const files = await FileInventory.find({
            status: 'active',
            thumbnail_key: { $exists: false }
        }).limit(limit);

        if (files.length === 0) {
            return res.json({ success: true, message: 'No files need processing' });
        }

        const results = [];
        
        for (const file of files) {
            console.log(`[Batch-Thumb] Processing ${file.hash} (${file.filename})...`);
            const tempVideoPath = path.join('/tmp', `reprocess_${file.hash}.mp4`);
            
            try {
                // 1. Download only the first 5MB of the video from R2
                const r2 = await getR2Client(file.bucket_name);
                const command = new GetObjectCommand({
                    Bucket: file.bucket_name,
                    Key: file.object_key,
                    Range: 'bytes=0-5000000' // 5MB should be enough for a frame at 1s
                });

                const response = await r2.send(command);
                const fileStream = fs.createWriteStream(tempVideoPath);
                
                await new Promise((resolve, reject) => {
                    response.Body.pipe(fileStream);
                    response.Body.on('error', reject);
                    fileStream.on('finish', resolve);
                });

                // 2. Generate thumbnail using the service
                const thumb = await mediaService.processVideoThumbnail(tempVideoPath, file.hash);
                
                results.push({ hash: file.hash, success: !!thumb });
            } catch (err) {
                console.error(`[Batch-Thumb] Error for ${file.hash}:`, err.message);
                results.push({ hash: file.hash, success: false, error: err.message });
            } finally {
                if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
            }
        }

        res.json({ success: true, processed: results.length, details: results });
    } catch (err) {
        console.error(`[Batch-Thumb] Critical Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
