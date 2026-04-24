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
        const { bucket_name, account_id, access_key_id, secret_access_key, endpoint, type, region, max_storage, is_read_only } = req.body;

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
            status: 'active',
            max_storage: max_storage || undefined,
            is_read_only: is_read_only || false
        });

        await newBucket.save();
        
        // Clear R2 client cache to reinitialize with new bucket
        r2Clients.clear();
        
        res.status(201).json({ success: true, bucket: newBucket });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/:bucket_name', verifyToken, async (req, res) => {
    try {
        const { bucket_name } = req.params;
        const { status, is_read_only, max_storage, type } = req.body;

        const bucket = await Bucket.findOne({ bucket_name });
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const updates = {};
        if (status !== undefined) updates.status = status;
        if (is_read_only !== undefined) updates.is_read_only = is_read_only;
        if (max_storage !== undefined) updates.max_storage = max_storage;
        if (type !== undefined) updates.type = type;

        const updatedBucket = await Bucket.findOneAndUpdate(
            { bucket_name },
            { $set: updates },
            { new: true }
        );

        res.json({ success: true, bucket: updatedBucket });
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

router.get('/:bucket_name/test', verifyToken, async (req, res) => {
    try {
        const { bucket_name } = req.params;
        const bucket = await Bucket.findOne({ bucket_name });
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const { getR2Client } = require('../services/r2');
        const { HeadBucketCommand } = require('@aws-sdk/client-s3');
        
        const client = await getR2Client(bucket_name);
        if (!client) {
            return res.status(500).json({ error: 'Failed to initialize storage client' });
        }

        const command = new HeadBucketCommand({ Bucket: bucket_name });
        await client.send(command);

        res.json({ success: true, message: 'Connection successful!' });
    } catch (err) {
        console.error(`[TEST-CONNECTION] Failed for ${req.params.bucket_name}: ${err.message}`);
        res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
});

router.post('/migrate', verifyToken, async (req, res) => {
    try {
        const { source_bucket, target_bucket } = req.body;
        if (!source_bucket || !target_bucket) {
            return res.status(400).json({ error: 'source_bucket and target_bucket required' });
        }
        if (source_bucket === target_bucket) {
            return res.status(400).json({ error: 'Source and target must be different' });
        }

        const sourceBucketInfo = await Bucket.findOne({ bucket_name: source_bucket });
        const targetBucketInfo = await Bucket.findOne({ bucket_name: target_bucket });

        if (!sourceBucketInfo || !targetBucketInfo) {
            return res.status(404).json({ error: 'One or both buckets not found' });
        }

        if (!targetBucketInfo.is_read_only) {
            return res.status(400).json({ error: 'Target bucket must be a read-only bucket' });
        }

        // Start migration asynchronously
        res.json({ success: true, message: 'Migration started in the background' });

        (async () => {
            try {
                const files = await FileInventory.find({ bucket_name: source_bucket, status: 'active' });
                const { getR2Client } = require('../services/r2');
                const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
                
                const sourceClient = await getR2Client(source_bucket);
                const targetClient = await getR2Client(target_bucket);

                if (!sourceClient || !targetClient) {
                    console.error('[MIGRATE] Failed to get R2 clients');
                    return;
                }

                let migratedCount = 0;
                let migratedBytes = 0;

                for (const file of files) {
                    try {
                        console.log(`[MIGRATE] Migrating ${file.hash}...`);
                        const getCommand = new GetObjectCommand({
                            Bucket: source_bucket,
                            Key: file.object_key
                        });
                        const response = await sourceClient.send(getCommand);
                        
                        const putCommand = new PutObjectCommand({
                            Bucket: target_bucket,
                            Key: file.object_key,
                            Body: response.Body,
                            ContentType: response.ContentType,
                            ContentLength: response.ContentLength
                        });
                        await targetClient.send(putCommand);

                        // Update DB
                        file.bucket_name = target_bucket;
                        await file.save();

                        // Update Stats
                        await Bucket.updateOne({ bucket_name: source_bucket }, {
                            $inc: { storage_used: -file.size, file_count: -1 }
                        });
                        await Bucket.updateOne({ bucket_name: target_bucket }, {
                            $inc: { storage_used: file.size, file_count: 1 }
                        });

                        // Delete from source
                        const delCommand = new DeleteObjectCommand({
                            Bucket: source_bucket,
                            Key: file.object_key
                        });
                        await sourceClient.send(delCommand);

                        migratedCount++;
                        migratedBytes += file.size;
                    } catch (err) {
                        console.error(`[MIGRATE] Error migrating file ${file.hash}: ${err.message}`);
                    }
                }
                console.log(`[MIGRATE] Finished migrating ${migratedCount} files (${migratedBytes} bytes) from ${source_bucket} to ${target_bucket}`);
            } catch (err) {
                console.error(`[MIGRATE] Background task error: ${err.message}`);
            }
        })();
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
                thumbnail_key: f.thumbnail_key,
                thumbnail_address: f.thumbnail_address || `/api/thumbnail/${f.hash}`
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
