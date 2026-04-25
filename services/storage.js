const crypto = require('crypto');
const { Bucket, FileInventory } = require('../db/models');

function hashFile(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function getAvailableBucket(type = 'video') {
    const query = { status: 'active', is_read_only: { $ne: true } };
    if (type === 'video') {
        query.$or = [{ type: 'video' }, { type: { $exists: false } }];
    } else {
        query.type = type;
    }

    const buckets = await Bucket.find(query);
    if (buckets.length === 0) throw new Error(`No active buckets of type ${type}`);

    let bestBucket = null;
    let maxFreeSpace = -1;

    for (const bucket of buckets) {
        const freeSpace = bucket.max_storage - bucket.storage_used;
        if (freeSpace > maxFreeSpace) {
            maxFreeSpace = freeSpace;
            bestBucket = bucket;
        }
    }

    return bestBucket;
}

async function getTotalStats() {
    const buckets = await Bucket.find();
    const totalFiles = await FileInventory.countDocuments({ status: 'active' });
    
    let totalUsed = 0;
    let totalMax = 0;
    const bucketStats = [];

    for (const bucket of buckets) {
        if (!bucket.is_read_only && bucket.type !== 'thumbnail') {
            totalUsed += (bucket.storage_used || 0);
            totalMax += (bucket.max_storage || 0);
        }
        
        bucketStats.push({
            bucket_name: bucket.bucket_name,
            type: bucket.type || 'video',
            status: bucket.status,
            is_read_only: bucket.is_read_only || false,
            storage_used: bucket.storage_used,
            max_storage: bucket.max_storage,
            free_space: bucket.max_storage - bucket.storage_used,
            file_count: bucket.file_count,
            percentage_used: bucket.max_storage ? ((bucket.storage_used / bucket.max_storage) * 100).toFixed(2) : "0.00"
        });
    }

    return {
        total_buckets: buckets.length,
        total_storage_used: totalUsed,
        total_max_storage: totalMax,
        total_free_space: totalMax - totalUsed,
        total_files: totalFiles,
        percentage_used: totalMax > 0 ? ((totalUsed / totalMax) * 100).toFixed(2) : "0.00",
        buckets: bucketStats
    };
}

module.exports = { hashFile, getAvailableBucket, getTotalStats };
