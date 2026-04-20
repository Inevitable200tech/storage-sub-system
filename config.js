require('dotenv').config({ path: "cert.env" });

const NODE_ID = process.env.NODE_ID || 'node-1';
const MAX_BUCKET_SIZE = 10 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || 1 * 1024 * 1024 * 1024;
const MAX_BUCKETS = 10;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';
const JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret-key-change-in-production';
const MONGODB_URI = process.env.SUB_MONGODB_URI;

module.exports = {
    NODE_ID,
    MAX_BUCKET_SIZE,
    MAX_FILE_SIZE,
    MAX_BUCKETS,
    ADMIN_KEY,
    JWT_SECRET,
    MONGODB_URI
};
