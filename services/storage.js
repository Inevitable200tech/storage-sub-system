const crypto = require('crypto');
const { Bucket, FileInventory } = require('../db/models');

function hashFile(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function getAvailableBucket() {
    const buckets = await Bucket.find({ status: 'active' });
    if (buckets.length === 0) throw new Error('No active buckets');

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
    const files = await FileInventory.find({ status: 'active' });
    
    let totalUsed = 0;
    let totalMax = 0;
    const bucketStats = [];

    for (const bucket of buckets) {
        totalUsed += bucket.storage_used;
        totalMax += bucket.max_storage;
        
        bucketStats.push({
            bucket_name: bucket.bucket_name,
            storage_used: bucket.storage_used,
            max_storage: bucket.max_storage,
            free_space: bucket.max_storage - bucket.storage_used,
            file_count: bucket.file_count,
            percentage_used: ((bucket.storage_used / bucket.max_storage) * 100).toFixed(2)
        });
    }

    return {
        total_buckets: buckets.length,
        total_storage_used: totalUsed,
        total_max_storage: totalMax,
        total_free_space: totalMax - totalUsed,
        total_files: files.length,
        percentage_used: ((totalUsed / totalMax) * 100).toFixed(2),
        buckets: bucketStats
    };
}

module.exports = { hashFile, getAvailableBucket, getTotalStats };
