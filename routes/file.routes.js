const express = require('express');
const router = express.Router();
const fs = require('fs');
const crypto = require('crypto');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Bucket, FileInventory } = require('../db/models');
const { verifyToken } = require('../middleware/auth');
const { NODE_ID, MAX_FILE_SIZE, JWT_SECRET } = require('../config');
const { getR2Client } = require('../services/r2');
const { getAvailableBucket } = require('../services/storage');
const mediaService = require('../services/media');


// ============ FILE OPERATIONS ============

router.post('/upload', async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const file = req.files.file;
        tempFilePath = file.tempFilePath; // Path to the file on disk
        
        // 1. Check File Size Limit
        if (file.size > MAX_FILE_SIZE) {
            if (tempFilePath) fs.unlinkSync(tempFilePath);
            return res.status(413).json({ error: `File too large` });
        }

        // 2. Handle Hash (Use provided hash or generate from stream to save RAM)
        const hash = req.body.hash || await new Promise((resolve, reject) => {
            const hashStream = crypto.createHash('sha256');
            const rs = fs.createReadStream(tempFilePath);
            rs.on('error', reject);
            rs.on('data', chunk => hashStream.update(chunk));
            rs.on('end', () => resolve(hashStream.digest('hex')));
        });

        const filename = file.name;

        // 3. CHECK FOR DUPLICATES (409 Logic)
        const existing = await FileInventory.findOne({ hash, status: 'active' });
        if (existing) {
            console.log(`[R2-UPLOAD] 🔁 Duplicate detected: ${hash}`);
            if (tempFilePath) fs.unlinkSync(tempFilePath); // Clean up temp file
            
            // Return 409 with existing metadata so Main Instance can mark as complete
            return res.status(409).json({ 
                error: 'File already exists',
                hash: existing.hash,
                bucket: existing.bucket_name,
                key: existing.object_key
            });
        }

        // 4. Find Storage Space
        const bucket = await getAvailableBucket();
        if (!bucket) {
            if (tempFilePath) fs.unlinkSync(tempFilePath);
            return res.status(507).json({ error: 'No available buckets' });
        }

        const freeSpace = bucket.max_storage - bucket.storage_used;
        if (file.size > freeSpace) {
            if (tempFilePath) fs.unlinkSync(tempFilePath);
            return res.status(507).json({ error: `Insufficient space` });
        }

        const objectKey = `${NODE_ID}/${hash}`;

        // 5. STREAM UPLOAD TO R2 (CRITICAL: Zero RAM usage)
        console.log(`[R2-UPLOAD] 🚀 Streaming to R2: ${bucket.bucket_name}`);
        
        try {
            const r2Client = await getR2Client(bucket.bucket_name);
            if (!r2Client) throw new Error('Failed to initialize R2 client');

            const fileStream = fs.createReadStream(tempFilePath);

            await r2Client.send(new PutObjectCommand({
                Bucket: bucket.bucket_name,
                Key: objectKey,
                Body: fileStream, // Passing the stream instead of a buffer
                ContentType: 'application/octet-stream',
                Metadata: {
                    'original-filename': filename
                }
            }));

            console.log(`[R2-UPLOAD] ✅ Stream upload successful`);
        } catch (r2Error) {
            if (tempFilePath) fs.unlinkSync(tempFilePath);
            throw new Error(`R2 upload failed: ${r2Error.message}`);
        }

        // 6. SAVE METADATA
        const newFile = new FileInventory({
            hash, 
            filename, 
            size: file.size,
            bucket_name: bucket.bucket_name,
            object_key: objectKey,
            status: 'active'
        });

        await newFile.save();
        await Bucket.updateOne({ bucket_name: bucket.bucket_name }, {
            $inc: { storage_used: file.size, file_count: 1 }
        });

        // 7. THUMBNAIL GENERATION (Async so it doesn't block response)
        // Note: In a production environment, this should be a background worker job
        const isVideo = file.mimetype && file.mimetype.startsWith('video/');
        if (isVideo) {
            console.log(`[THUMBNAIL] 🖼️ Generating for ${hash}...`);
            mediaService.processVideoThumbnail(tempFilePath, hash).catch(err => {
                console.error(`[THUMBNAIL] ❌ Error: ${err.message}`);
            });
        }

        // 8. CLEANUP & RESPOND
        // Wait briefly for thumbnail generation if it's quick, or just use a copy if async
        // For simplicity, we'll keep the temp file until thumbnail generation starts/finishes
        // Better: extractThumbnail needs the file.
        
        // Wait for it? If we want to be sure. But the user wants upcoming videos.
        // Let's wait to ensure the file is available for the spawn process.
        
        setTimeout(() => {
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
                console.log(`[R2-UPLOAD] 🗑️ Cleaned up temp file`);
            }
        }, 5000); // 5s buffer for FFmpeg to start/finish

        res.status(201).json({
            success: true, 
            node_id: NODE_ID, 
            hash, 
            bucket: bucket.bucket_name, 
            key: objectKey, 
            status: 'stored_in_r2'
        });

    } catch (err) {
        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        console.error(`[R2-UPLOAD] ❌ Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ============ FILE DOWNLOAD/STREAMING - NEW ENDPOINT ============

router.get('/download/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const { expires, signature } = req.query;

        // 1. SIGNATURE VALIDATION (Security)
        if (!expires || !signature) {
            return res.status(403).json({ error: 'Missing security signature' });
        }

        if (Date.now() > parseInt(expires)) {
            return res.status(403).json({ error: 'Download link has expired' });
        }

        // Re-calculate hash to verify the signature (using your JWT_SECRET or a custom ADMIN_KEY)
        const expectedSignature = crypto.createHmac('sha256', JWT_SECRET)
            .update(`${hash}${expires}`)
            .digest('hex');

        if (signature !== expectedSignature) {
            return res.status(403).json({ error: 'Invalid security signature' });
        }

        // 2. FIND FILE
        const file = await FileInventory.findOne({ hash, status: 'active' });
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // 3. INITIALIZE R2 CLIENT
        const r2Client = await getR2Client(file.bucket_name);
        if (!r2Client) {
            return res.status(500).json({ error: 'Storage node configuration error' });
        }

        // 4. STREAM FROM R2 DIRECTLY TO RESPONSE (Memory Safe)
        const command = new GetObjectCommand({
            Bucket: file.bucket_name,
            Key: file.object_key
        });

        const r2Response = await r2Client.send(command);

        // Set standard headers
        res.setHeader('Content-Type', 'video/mp4'); // Or 'application/octet-stream'
        res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
        res.setHeader('Content-Length', file.size);
        res.setHeader('Accept-Ranges', 'bytes'); // Crucial for video seeking/scrubbing

        console.log(`[DOWNLOAD] 🚀 Streaming ${file.filename} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        // Pipe the R2 stream directly to the Express 'res' object
        // This prevents the file from ever being fully loaded into your server's RAM
        r2Response.Body.pipe(res);

        // Cleanup: Handle connection drops
        res.on('close', () => {
            if (r2Response.Body.destroy) r2Response.Body.destroy();
        });

    } catch (err) {
        console.error(`[DOWNLOAD] ❌ Critical Error: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error during download' });
        }
    }
});

router.post('/delete', verifyToken, async (req, res) => {
    try {
        const { hash } = req.body;
        if (!hash) return res.status(400).json({ error: 'hash required' });

        const file = await FileInventory.findOne({ hash });
        if (!file) return res.status(404).json({ error: 'File not found' });

        // Delete from R2
        try {
            const r2Client = await getR2Client(file.bucket_name);
            if (r2Client) {
                await r2Client.send(new DeleteObjectCommand({
                    Bucket: file.bucket_name,
                    Key: file.object_key
                }));
                console.log(`[DELETE] ✅ Deleted from R2: ${file.object_key}`);
            }
        } catch (r2Error) {
            console.error(`[DELETE] ❌ Failed to delete from R2: ${r2Error.message}`);
            return res.status(500).json({ error: `Failed to delete from R2: ${r2Error.message}` });
        }

        // Update bucket stats
        const bucket = await Bucket.findOne({ bucket_name: file.bucket_name });
        if (bucket) {
            await Bucket.updateOne({ bucket_name: file.bucket_name }, {
                $inc: { storage_used: -file.size, file_count: -1 }
            });
        }

        // Mark as deleted in inventory
        await FileInventory.updateOne({ hash }, { status: 'deleted' });
        
        console.log(`[DELETE] ✅ File deleted: ${hash}`);
        res.json({ success: true, hash });
    } catch (err) {
        console.error(`[DELETE] ❌ Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.get('/thumbnail/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const file = await FileInventory.findOne({ hash, status: 'active' });
        
        if (!file || !file.thumbnail_key || !file.thumbnail_bucket) {
            return res.status(404).json({ error: 'Thumbnail not found' });
        }

        const r2Client = await getR2Client(file.thumbnail_bucket);
        if (!r2Client) return res.status(500).json({ error: 'Storage node configuration error' });

        const command = new GetObjectCommand({
            Bucket: file.thumbnail_bucket,
            Key: file.thumbnail_key
        });

        const r2Response = await r2Client.send(command);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
        r2Response.Body.pipe(res);

    } catch (err) {
        console.error(`[THUMB-SERVE] ❌ Error: ${err.message}`);
        res.status(500).json({ error: 'Failed to serve thumbnail' });
    }
});

module.exports = router;
