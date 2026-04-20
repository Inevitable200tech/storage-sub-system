const fs = require('fs');
const path = require('path');

const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

module.exports = { DASHBOARD_HTML };
