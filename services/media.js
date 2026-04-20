const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getR2Client } = require('./r2');
const { getAvailableBucket } = require('./storage');
const { FileInventory, Bucket } = require('../db/models');

/**
 * Extracts a frame from a video file at 1 second mark.
 */
async function extractThumbnail(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
            '-err_detect', 'ignore_err',
            '-i', inputPath,
            '-ss', '00:00:01',
            '-vframes', '1',
            '-q:v', '2',
            '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
            '-y', // Overwrite
            outputPath
        ]);

        const stderr = [];
        ffmpeg.stderr.on('data', (data) => stderr.push(data));

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else {
                const errorMsg = Buffer.concat(stderr).toString();
                console.error(`[FFMPEG-ERROR] Code ${code}: ${errorMsg}`);
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Processes a video to generate and upload a thumbnail.
 */
async function processVideoThumbnail(tempVideoPath, fileHash) {
    const tempThumbPath = path.join(path.dirname(tempVideoPath), `thumb_${fileHash}.jpg`);
    
    try {
        // 1. Find a thumbnail bucket
        const thumbBucket = await getAvailableBucket('thumbnail');
        
        // 2. Extract frame
        await extractThumbnail(tempVideoPath, tempThumbPath);
        
        // 3. Upload to R2
        const r2 = await getR2Client(thumbBucket.bucket_name);
        const objectKey = `thumbnails/${fileHash}.jpg`;
        const thumbBuffer = fs.readFileSync(tempThumbPath);
        
        await r2.send(new PutObjectCommand({
            Bucket: thumbBucket.bucket_name,
            Key: objectKey,
            Body: thumbBuffer,
            ContentType: 'image/jpeg'
        }));

        console.log(`[Thumbnail] ✅ Uploaded to ${thumbBucket.bucket_name}/${objectKey}`);
        
        // 4. Update Database
        await FileInventory.findOneAndUpdate(
            { hash: fileHash },
            { thumbnail_bucket: thumbBucket.bucket_name, thumbnail_key: objectKey }
        );

        // 5. Update Bucket Stats
        await Bucket.findOneAndUpdate(
            { bucket_name: thumbBucket.bucket_name },
            { $inc: { storage_used: thumbBuffer.length, file_count: 1 } }
        );

        return { bucket: thumbBucket.bucket_name, key: objectKey };
    } catch (err) {
        console.error(`[Thumbnail] Failed for ${fileHash}:`, err.message);
        return null;
    } finally {
        if (fs.existsSync(tempThumbPath)) fs.unlinkSync(tempThumbPath);
    }
}

module.exports = {
    extractThumbnail,
    processVideoThumbnail
};
