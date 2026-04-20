const mongoose = require('mongoose');
const { MAX_BUCKET_SIZE } = require('../config');

const bucketSchema = new mongoose.Schema({
    bucket_name: { type: String, required: true, unique: true },
    type: { type: String, enum: ['video', 'thumbnail'], default: 'video' },
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    endpoint: String,
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    storage_used: { type: Number, default: 0 },
    file_count: { type: Number, default: 0 },
    max_storage: { type: Number, default: MAX_BUCKET_SIZE },
    created_at: { type: Date, default: Date.now }
});

const fileInventorySchema = new mongoose.Schema({
    hash: { type: String, required: true, unique: true, index: true },
    filename: String,
    size: Number,
    bucket_name: String,
    object_key: String,
    thumbnail_bucket: String,
    thumbnail_key: String,
    status: { type: String, enum: ['active', 'deleted'], default: 'active' },
    uploadedAt: { type: Date, default: Date.now }
});

const Bucket = mongoose.model('Bucket', bucketSchema);
const FileInventory = mongoose.model('FileInventory', fileInventorySchema);

module.exports = { Bucket, FileInventory };
