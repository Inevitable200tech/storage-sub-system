const jwt = require('jsonwebtoken');
const { JWT_SECRET, ADMIN_KEY } = require('../config');

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    // Allow literal ADMIN_KEY (used by Main API for internal requests)
    if (token === ADMIN_KEY) {
        return next();
    }
    
    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

module.exports = { verifyToken };
