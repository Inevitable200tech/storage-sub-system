const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config({ path: "cert.env" });
const fs = require('fs'); // Add this to the top of your file

const app = express();
app.use(express.json());
// Change this to true to prevent RAM exhaustion
app.use(fileUpload({ 
    useTempFiles: true, 
    tempFileDir: '/tmp/' 
}));

mongoose.connect(process.env.SUB_MONGODB_URI);

const NODE_ID = process.env.NODE_ID || 'node-1';
const MAX_BUCKET_SIZE = 10 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || 1 * 1024 * 1024 * 1024;
const MAX_BUCKETS = 10;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';
const JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret-key-change-in-production';

console.log(`⚙️  Configuration loaded:`);
console.log(`   NODE_ID: ${NODE_ID}`);
console.log(`   ADMIN_KEY: ${ADMIN_KEY}`);
console.log(`   MAX_BUCKETS: ${MAX_BUCKETS}`);

// ============ SCHEMAS ============

const bucketSchema = new mongoose.Schema({
    bucket_name: { type: String, required: true, unique: true },
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
    status: { type: String, enum: ['active', 'deleted'], default: 'active' },
    uploadedAt: { type: Date, default: Date.now }
});

const Bucket = mongoose.model('Bucket', bucketSchema);
const FileInventory = mongoose.model('FileInventory', fileInventorySchema);

// ============ R2 CLIENT MANAGEMENT ============

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

        // Create new R2 client
        const client = new S3Client({
            region: 'auto',
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

// ============ FILE STREAMING FROM R2 ============

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

// ============ AUTH MIDDLEWARE ============

function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// ============ UTILITY FUNCTIONS ============

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

// ============ HTML PAGES ============

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sub-Instance - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #333;
    }
    .login-container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    .login-header {
      text-align: center;
      margin-bottom: 30px;
    }
    .login-header h1 {
      font-size: 28px;
      margin-bottom: 10px;
      color: #2c3e50;
    }
    .login-header p {
      color: #999;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #2c3e50;
    }
    .form-group input {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      transition: border-color 0.3s;
    }
    .form-group input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    .login-btn {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .login-btn:hover { transform: translateY(-2px); }
    .message {
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .loading { display: none; text-align: center; }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .info-text {
      font-size: 12px;
      color: #999;
      text-align: center;
      margin-top: 20px;
    }
    .info-text code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-header">
      <h1>🔧 Sub-Instance</h1>
      <p>Admin Dashboard</p>
    </div>
    <div id="message"></div>
    <form onsubmit="handleLogin(event)">
      <div class="form-group">
        <label>Admin Key</label>
        <input type="password" id="admin-key" placeholder="Enter admin key" required autofocus>
      </div>
      <button type="submit" class="login-btn" id="submit-btn">
        <span id="btn-text">Login</span>
        <span id="spinner" class="loading"><div class="spinner"></div></span>
      </button>
    </form>
    <div class="info-text">
      Default key: <code>admin-secret-key</code><br>
      Change it in .env file: <code>ADMIN_KEY</code>
    </div>
  </div>
  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const adminKey = document.getElementById('admin-key').value;
      const submitBtn = document.getElementById('submit-btn');
      const btnText = document.getElementById('btn-text');
      const spinner = document.getElementById('spinner');
      const messageEl = document.getElementById('message');

      submitBtn.disabled = true;
      btnText.style.display = 'none';
      spinner.style.display = 'inline-block';
      messageEl.innerHTML = '';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ admin_key: adminKey })
        });

        const data = await res.json();

        if (!res.ok) {
          messageEl.innerHTML = \`<div class="message error">\${data.error}</div>\`;
          submitBtn.disabled = false;
          btnText.style.display = 'inline';
          spinner.style.display = 'none';
          return;
        }

        localStorage.setItem('token', data.token);
        messageEl.innerHTML = '<div class="message success">Login successful! Redirecting...</div>';
        
        setTimeout(() => {
          window.location.href = '/dashboard';
        }, 1000);

      } catch (err) {
        messageEl.innerHTML = \`<div class="message error">Error: \${err.message}</div>\`;
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        spinner.style.display = 'none';
      }
    }

    window.addEventListener('load', () => {
      const token = localStorage.getItem('token');
      if (token) {
        window.location.href = '/dashboard';
      }
    });
  </script>
</body>
</html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sub-Instance Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        header { background: #34495e; color: white; padding: 30px; border-radius: 8px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
        header h1 { font-size: 28px; }
        .logout-btn { padding: 10px 20px; background: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
        .logout-btn:hover { background: #c0392b; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 2px solid #ddd; }
        .tab-btn { padding: 12px 20px; border: none; background: none; cursor: pointer; font-size: 16px; border-bottom: 3px solid transparent; margin-bottom: -2px; }
        .tab-btn.active { color: #e74c3c; border-bottom-color: #e74c3c; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .section h2 { margin-bottom: 20px; font-size: 20px; color: #34495e; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }
        .stat-card.red { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
        .stat-card.blue { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
        .stat-card.green { background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%); }
        .stat-value { font-size: 28px; font-weight: bold; margin-bottom: 5px; }
        .stat-label { font-size: 12px; opacity: 0.9; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 500; }
        .form-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        button { padding: 10px 20px; background: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
        button:hover { background: #2980b9; }
        button.danger { background: #e74c3c; }
        button.danger:hover { background: #c0392b; }
        .bucket-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
        .bucket-card { background: #f9f9f9; border: 1px solid #ddd; border-radius: 8px; padding: 15px; }
        .bucket-card h3 { margin-bottom: 10px; color: #34495e; }
        .bucket-status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: #d4edda; color: #155724; margin-bottom: 10px; }
        .bucket-info { font-size: 13px; margin-bottom: 8px; color: #666; }
        .progress-bar { width: 100%; height: 20px; background: #e0e0e0; border-radius: 4px; overflow: hidden; margin-bottom: 10px; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; display: flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: bold; }
        .bucket-actions { display: flex; gap: 8px; margin-top: 10px; }
        .bucket-actions button { flex: 1; padding: 8px; font-size: 12px; }
        .files-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        .files-table thead { background: #f5f5f5; }
        .files-table th, .files-table td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; font-size: 13px; }
        .files-table th { font-weight: 600; color: #34495e; }
        .message { padding: 12px; border-radius: 4px; margin-bottom: 15px; }
        .message.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .message.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        @media (max-width: 768px) { header { flex-direction: column; gap: 15px; } .stats-grid { grid-template-columns: 2fr; } .form-row { grid-template-columns: 1fr; } .bucket-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <h1>🔧 Dashboard</h1>
                <p id="node-info">Node: Loading...</p>
            </div>
            <button class="logout-btn" onclick="logout()">🚪 Logout</button>
        </header>

        <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('status')">Status</button>
            <button class="tab-btn" onclick="switchTab('buckets')">R2 Buckets</button>
            <button class="tab-btn" onclick="switchTab('files')">Files</button>
        </div>

        <div id="status" class="tab-content active">
            <div class="section">
                <h2>System Status</h2>
                <div class="stats-grid">
                    <div class="stat-card"><div class="stat-value" id="stat-total-buckets">0</div><div class="stat-label">Buckets</div></div>
                    <div class="stat-card red"><div class="stat-value" id="stat-total-files">0</div><div class="stat-label">Files</div></div>
                    <div class="stat-card blue"><div class="stat-value" id="stat-used">0 GB</div><div class="stat-label">Used</div></div>
                    <div class="stat-card green"><div class="stat-value" id="stat-available">0 GB</div><div class="stat-label">Available</div></div>
                </div>
            </div>

            <div class="section">
                <h2>Bucket Breakdown</h2>
                <table class="files-table">
                    <thead><tr><th>Bucket</th><th>Files</th><th>Used / Max</th><th>%</th></tr></thead>
                    <tbody id="bucket-stats"><tr><td colspan="4">Loading...</td></tr></tbody>
                </table>
            </div>
        </div>

        <div id="buckets" class="tab-content">
            <div class="section">
                <h2>Add R2 Bucket</h2>
                <div id="bucket-message"></div>
                <form onsubmit="addBucket(event)">
                    <div class="form-row">
                        <div class="form-group"><label>Bucket Name</label><input type="text" id="bucket-name" placeholder="my-bucket" required></div>
                        <div class="form-group"><label>Account ID</label><input type="text" id="account-id" placeholder="Cloudflare Account ID" required></div>
                    </div>
                    <div class="form-row">
                        <div class="form-group"><label>Access Key</label><input type="text" id="access-key-id" required></div>
                        <div class="form-group"><label>Secret Key</label><input type="password" id="secret-access-key" required></div>
                    </div>
                    <button type="submit">Add Bucket</button>
                </form>
            </div>

            <div class="section">
                <h2>Buckets</h2>
                <div class="bucket-grid" id="buckets-list"><p>Loading...</p></div>
            </div>
        </div>

        <div id="files" class="tab-content">
            <div class="section">
                <h2>Files by Bucket</h2>
                <div id="files-list"><p>Loading...</p></div>
            </div>
        </div>
    </div>

    <script>
        // Single source of truth: localStorage only
        const token = localStorage.getItem('token');

        // No token = not logged in, redirect to login
        if (!token) {
            console.log('❌ No token in localStorage - redirecting to login');
            window.location.href = '/';
        }

        console.log('✅ Dashboard loaded - token found in localStorage');

        function logout() {
            console.log('🚪 Logging out - clearing token');
            localStorage.removeItem('token');
            // Redirect to clean login page (no query params)
            window.location.href = '/';
        }

        function switchTab(tab) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
            document.getElementById(tab).classList.add('active');
            event.target.classList.add('active');
            if (tab === 'status') loadStatus();
            if (tab === 'buckets') loadBuckets();
            if (tab === 'files') loadFiles();
        }

        function showMessage(el, msg, type) {
            document.getElementById(el).innerHTML = \`<div class="message \${type}">\${msg}</div>\`;
            setTimeout(() => document.getElementById(el).innerHTML = '', 3000);
        }

        function formatBytes(b) {
            if (b === 0) return '0 B';
            const k = 1024, s = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(b) / Math.log(k));
            return (b / Math.pow(k, i)).toFixed(2) + ' ' + s[i];
        }

        async function apiCall(url, opts = {}) {
            const headers = { 'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json', ...opts.headers };
            const res = await fetch(url, { ...opts, headers });
            if (res.status === 401 || res.status === 403) {
                localStorage.removeItem('token');
                window.location.href = '/';
                return null;
            }
            return res;
        }

        async function loadStatus() {
            try {
                const res = await fetch('/api/status');
                const d = await res.json();
                if (!d.success) return;
                const s = d.stats;
                document.getElementById('node-info').textContent = \`Node: \${d.node_id}\`;
                document.getElementById('stat-total-buckets').textContent = s.total_buckets;
                document.getElementById('stat-total-files').textContent = s.total_files;
                document.getElementById('stat-used').textContent = formatBytes(s.total_storage_used);
                document.getElementById('stat-available').textContent = formatBytes(s.total_free_space);
                const html = s.buckets.map(b => \`<tr><td><strong>\${b.bucket_name}</strong></td><td>\${b.file_count}</td><td>\${formatBytes(b.storage_used)} / \${formatBytes(b.max_storage)}</td><td><div class="progress-bar"><div class="progress-fill" style="width: \${b.percentage_used}%">\${b.percentage_used}%</div></div></td></tr>\`).join('');
                document.getElementById('bucket-stats').innerHTML = html || '<tr><td colspan="4">No buckets</td></tr>';
            } catch (e) { console.error(e); }
        }

        async function loadBuckets() {
            try {
                const res = await fetch('/api/buckets');
                const d = await res.json();
                const html = d.buckets.map(b => \`<div class="bucket-card"><h3>\${b.bucket_name}</h3><span class="bucket-status">\${b.status}</span><div class="bucket-info"><strong>Account:</strong> \${b.account_id}</div><div class="bucket-info"><strong>Files:</strong> \${b.file_count}</div><div class="bucket-info"><strong>Storage:</strong> \${formatBytes(b.storage_used)} / \${formatBytes(b.max_storage)}</div><div class="progress-bar"><div class="progress-fill" style="width: \${((b.storage_used / b.max_storage) * 100).toFixed(2)}%">\${((b.storage_used / b.max_storage) * 100).toFixed(1)}%</div></div><div class="bucket-actions"><button onclick="loadFiles(); switchTab('files')">Files</button><button class="danger" onclick="delBucket('\${b.bucket_name}')">Delete</button></div></div>\`).join('');
                document.getElementById('buckets-list').innerHTML = html || '<p>No buckets</p>';
            } catch (e) { console.error(e); }
        }

        async function loadFiles() {
            try {
                const res = await fetch('/api/buckets');
                const d = await res.json();
                let html = '';
                for (const b of d.buckets) {
                    const fres = await fetch(\`/api/buckets/\${b.bucket_name}/files\`);
                    const fd = await fres.json();
                    html += \`<div class="section"><h3>📦 \${b.bucket_name}</h3><table class="files-table"><thead><tr><th>File</th><th>Hash</th><th>Size</th><th>Date</th></tr></thead><tbody>\`;
                    if (fd.files.length) {
                        html += fd.files.map(f => \`<tr><td>\${f.filename}</td><td><code>\${f.hash.substring(0, 16)}...</code></td><td>\${formatBytes(f.size)}</td><td>\${new Date(f.uploadedAt).toLocaleDateString()}</td></tr>\`).join('');
                    } else {
                        html += '<tr><td colspan="4">No files</td></tr>';
                    }
                    html += '</tbody></table></div>';
                }
                document.getElementById('files-list').innerHTML = html;
            } catch (e) { console.error(e); }
        }

        async function addBucket(e) {
            e.preventDefault();
            const data = {
                bucket_name: document.getElementById('bucket-name').value,
                account_id: document.getElementById('account-id').value,
                access_key_id: document.getElementById('access-key-id').value,
                secret_access_key: document.getElementById('secret-access-key').value
            };
            try {
                const res = await apiCall('/api/buckets', { method: 'POST', body: JSON.stringify(data) });
                if (!res) return;
                const d = await res.json();
                if (!res.ok) { showMessage('bucket-message', d.error, 'error'); return; }
                showMessage('bucket-message', 'Added!', 'success');
                e.target.reset();
                loadBuckets();
            } catch (err) { showMessage('bucket-message', 'Error: ' + err.message, 'error'); }
        }

        async function delBucket(name) {
            if (!confirm(\`Delete \${name}?\`)) return;
            try {
                const res = await apiCall(\`/api/buckets/\${name}\`, { method: 'DELETE' });
                if (!res) return;
                const d = await res.json();
                if (!res.ok) { showMessage('bucket-message', d.error, 'error'); return; }
                showMessage('bucket-message', 'Deleted!', 'success');
                loadBuckets();
            } catch (err) { showMessage('bucket-message', 'Error: ' + err.message, 'error'); }
        }

        loadStatus();
        setInterval(loadStatus, 5000);
    </script>
</body>
</html>`;

// ============ ROUTES ============

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(LOGIN_HTML);
});

app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(DASHBOARD_HTML);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', node_id: NODE_ID, uptime: process.uptime() });
});

// ============ AUTH ENDPOINT ============

app.post('/api/auth/login', async (req, res) => {
    try {
        const { admin_key } = req.body;
        
        if (!admin_key) return res.status(400).json({ error: 'Admin key required' });
        if (admin_key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
        
        const token = jwt.sign({ node_id: NODE_ID }, JWT_SECRET, { expiresIn: '24h' });
        console.log(`[LOGIN] ✅ Success for ${NODE_ID}`);
        res.json({ success: true, token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ BUCKET MANAGEMENT ============

app.get('/api/buckets', async (req, res) => {
    try {
        const buckets = await Bucket.find().sort({ created_at: -1 });
        res.json({ success: true, buckets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/buckets', verifyToken, async (req, res) => {
    try {
        const { bucket_name, account_id, access_key_id, secret_access_key, endpoint } = req.body;

        if (!bucket_name || !account_id || !access_key_id || !secret_access_key) {
            return res.status(400).json({ error: 'Missing required fields' });
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
            endpoint: endpoint || `https://${account_id}.r2.cloudflarestorage.com`,
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

app.delete('/api/buckets/:bucket_name', verifyToken, async (req, res) => {
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

// ============ STATUS ENDPOINTS ============

app.get('/api/status', async (req, res) => {
    try {
        const stats = await getTotalStats();
        res.json({ success: true, node_id: NODE_ID, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/space', async (req, res) => {
    try {
        const stats = await getTotalStats();
        res.json({ success: true, node_id: NODE_ID, ...stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ FILE OPERATIONS ============


import { request, FormData as UndiciFormData } from 'undici';
import fs from 'fs';

async function uploadFileToSubInstance(subInstance, filePath, fileName, fileHash, title) {
    if (!subInstance || !subInstance.url) return null;

    try {
        const url = `${subInstance.url.replace(/\/$/, '')}/api/upload`;
        
        // 1. Create a disk-backed Blob (Node 19.8+)
        // This is memory-efficient as it doesn't load the whole file into RAM at once
        let fileBlob;
        if (typeof fs.openAsBlob === 'function') {
            fileBlob = await fs.openAsBlob(filePath);
        } else {
            // Fallback for Node 18.x
            const buffer = fs.readFileSync(filePath);
            fileBlob = new Blob([buffer]);
        }

        console.log(`[UPLOAD-NODE] 📤 Streaming to ${subInstance.node_id} (${(fileBlob.size / 1024 / 1024).toFixed(2)} MB)`);

        const fd = new UndiciFormData();
        
        // 2. Append the Blob. 
        // Providing the 3rd argument (fileName) is CRITICAL for express-fileupload
        fd.append('file', fileBlob, fileName);
        fd.append('hash', fileHash);
        fd.append('title', title || fileName);

        console.log(`[UPLOAD-NODE] ⏳ Dispatching to sub-instance...`);

        const { statusCode, body } = await request(url, {
            method: 'POST',
            body: fd,
            headersTimeout: 600000, 
            bodyTimeout: 600000
        });

        const result = await body.json();

        if (statusCode >= 200 && statusCode < 300) {
            console.log(`[UPLOAD-NODE] ✅ Upload successful to ${subInstance.node_id}`);
            return result;
        }

        if (statusCode === 409) {
            console.log(`[UPLOAD-NODE] ⚠️ Duplicate on node.`);
            return { isDuplicate: true, ...result };
        }

        console.error(`[UPLOAD-NODE] ❌ Node rejected: ${JSON.stringify(result)}`);
        return null;

    } catch (err) {
        console.error(`[UPLOAD-NODE] ❌ Upload failed: ${err.message}`);
        return null;
    }
}

// ============ FILE DOWNLOAD/STREAMING - NEW ENDPOINT ============

app.get('/api/download/:hash', async (req, res) => {
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

// ============ SIGNED URL ENDPOINT ============

app.get('/api/signed-url', async (req, res) => {
    try {
        // 1. AUTHENTICATION CHECK
        // This ensures only the Main Instance (which holds your ADMIN_KEY) can request URLs
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];

        if (!token || token !== ADMIN_KEY) {
            console.error(`[SIGNED-URL] ❌ Unauthorized access attempt from ${req.ip}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { hash } = req.query;
        if (!hash) return res.status(400).json({ error: 'hash required' });

        // 2. Verify file exists and is active on this node
        const file = await FileInventory.findOne({ hash, status: 'active' });
        if (!file) {
            return res.status(404).json({ error: 'File not found on this storage node' });
        }

        // 3. Set Expiration (25 minutes)
        const expiresAt = Date.now() + (25 * 60 * 1000); 

        // 4. Generate HMAC Signature
        // Uses JWT_SECRET to sign the link so the /api/download route can verify it
        const signature = crypto.createHmac('sha256', JWT_SECRET)
            .update(`${hash}${expiresAt}`)
            .digest('hex');

        // 5. Build full URL
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const signedUrl = `${protocol}://${host}/api/download/${hash}?expires=${expiresAt}&signature=${signature}`;

        console.log(`[SIGNED-URL] 🔗 Link generated for: ${file.filename}`);

        res.json({
            success: true,
            signed_url: signedUrl,
            expires_at: expiresAt,
            filename: file.filename,
            size: file.size
        });

    } catch (err) {
        console.error(`[SIGNED-URL] ❌ Error: ${err.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/api/delete', verifyToken, async (req, res) => {
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

app.get('/api/buckets/:bucket_name/files', async (req, res) => {
    try {
        const { bucket_name } = req.params;
        const files = await FileInventory.find({ bucket_name, status: 'active' }).sort({ uploadedAt: -1 });

        res.json({
            success: true, bucket_name, total_files: files.length,
            files: files.map(f => ({ hash: f.hash, filename: f.filename, size: f.size, uploadedAt: f.uploadedAt }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\n🔧 Sub-Instance [${NODE_ID}] listening on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔑 Login: http://localhost:${PORT}/`);
    console.log(`💡 Use admin key: ${ADMIN_KEY}\n`);
});