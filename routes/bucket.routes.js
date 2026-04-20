const express = require('express');
const router = express.Router();
const { Bucket, FileInventory } = require('../db/models');
const { verifyToken } = require('../middleware/auth');
const { MAX_BUCKETS } = require('../config');
const { r2Clients } = require('../services/r2');

// ============ BUCKET MANAGEMENT ============

router.get('/', async (req, res) => {
    try {
        const buckets = await Bucket.find().sort({ created_at: -1 });
        res.json({ success: true, buckets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', verifyToken, async (req, res) => {
    try {
        const { bucket_name, account_id, access_key_id, secret_access_key, endpoint, type, region } = req.body;

        if (!bucket_name || (!account_id && !endpoint) || !access_key_id || !secret_access_key) {
            return res.status(400).json({ error: 'Missing required fields (bucket_name, access_key, secret_key, and either account_id or endpoint)' });
        }

        const bucketCount = await Bucket.countDocuments();
        if (bucketCount >= MAX_BUCKETS) {
            return res.status(429).json({ error: `Bucket limit: max ${MAX_BUCKETS}` });
        }

        const existing = await Bucket.findOne({ bucket_name });
        if (existing) return res.status(409).json({ error: 'Bucket already exists' });

        const newBucket = new Bucket({
            bucket_name,
            account_id,
            access_key_id,
            secret_access_key,
            type: type || 'video',
            region: region || 'auto',
            endpoint: endpoint || (account_id && account_id.includes('r2') ? `https://${account_id}.r2.cloudflarestorage.com` : endpoint),
            status: 'active'
        });

        await newBucket.save();
        
        // Clear R2 client cache to reinitialize with new bucket
        r2Clients.clear();
        
        res.status(201).json({ success: true, bucket: newBucket });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:bucket_name', verifyToken, async (req, res) => {
    try {
        const { bucket_name } = req.params;

        const bucket = await Bucket.findOne({ bucket_name });
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
        if (bucket.file_count > 0) return res.status(409).json({ error: 'Cannot delete bucket with files' });

        await Bucket.deleteOne({ bucket_name });
        
        // Clear R2 client cache
        r2Clients.delete(bucket_name);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:bucket_name/files', async (req, res) => {
    try {
        const { bucket_name } = req.params;
        const files = await FileInventory.find({ bucket_name, status: 'active' }).sort({ uploadedAt: -1 });

        res.json({
            success: true, bucket_name, total_files: files.length,
            files: files.map(f => ({ 
                hash: f.hash, 
                filename: f.filename, 
                size: f.size, 
                uploadedAt: f.uploadedAt,
                thumbnail_bucket: f.thumbnail_bucket,
                thumbnail_key: f.thumbnail_key
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
