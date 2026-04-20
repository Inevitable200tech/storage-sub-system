const fs = require('fs');
const path = require('path');

const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

module.exports = { LOGIN_HTML };
