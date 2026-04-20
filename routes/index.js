const express = require('express');
const router = express.Router();

const { LOGIN_HTML } = require('../views/login.html.js');
const { DASHBOARD_HTML } = require('../views/dashboard.html.js');

const authRoutes = require('./auth.routes');
const bucketRoutes = require('./bucket.routes');
const fileRoutes = require('./file.routes');
const signedUrlRoutes = require('./signed-url.routes');
const statusRoutes = require('./status.routes');

// ============ HTML PAGES ============

router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(LOGIN_HTML);
});

router.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(DASHBOARD_HTML);
});

// ============ API ROUTES ============

router.use('/api/auth', authRoutes);
router.use('/api/buckets', bucketRoutes);
router.use('/api', fileRoutes); // Routes like /api/upload, /api/download/:hash, /api/delete
router.use('/api/signed-url', signedUrlRoutes);
router.use('/', statusRoutes); // Routes like /api/status, /api/space, /health

module.exports = router;
