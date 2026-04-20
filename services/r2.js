const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Bucket } = require('../db/models');

const r2Clients = new Map(); // Map of bucket_name -> S3Client

async function getR2Client(bucketName) {
    try {
        // Return cached client if exists
        if (r2Clients.has(bucketName)) {
            return r2Clients.get(bucketName);
        }

        // Get bucket credentials from database
        const bucket = await Bucket.findOne({ bucket_name: bucketName });
        if (!bucket) {
            console.error(`[R2] ❌ Bucket ${bucketName} not found in database`);
            return null;
        }

        // Create new S3 client
        const client = new S3Client({
            region: bucket.region || 'auto',
            endpoint: bucket.endpoint,
            credentials: {
                accessKeyId: bucket.access_key_id,
                secretAccessKey: bucket.secret_access_key
            }
        });

        // Cache the client
        r2Clients.set(bucketName, client);
        console.log(`[R2] ✅ R2 client initialized for ${bucketName}`);

        return client;
    } catch (err) {
        console.error(`[R2] ❌ Failed to initialize R2 client: ${err.message}`);
        return null;
    }
}

async function getFileFromR2(bucketName, objectKey) {
    try {
        console.log(`[R2-DOWNLOAD] 📥 Fetching file from R2`);
        console.log(`[R2-DOWNLOAD]    Bucket: ${bucketName}`);
        console.log(`[R2-DOWNLOAD]    Key: ${objectKey}`);

        const client = await getR2Client(bucketName);
        if (!client) {
            throw new Error('R2 client not initialized');
        }

        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey
        });

        const response = await client.send(command);
        const fileBuffer = await response.Body.transformToByteArray();

        console.log(`[R2-DOWNLOAD] ✅ Downloaded successfully`);
        console.log(`[R2-DOWNLOAD]    Size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        return Buffer.from(fileBuffer);
    } catch (err) {
        console.error(`[R2-DOWNLOAD] ❌ Download failed: ${err.message}`);
        throw err;
    }
}

module.exports = { r2Clients, getR2Client, getFileFromR2 };
