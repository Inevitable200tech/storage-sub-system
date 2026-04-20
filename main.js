const express = require('express');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
const { MONGODB_URI, NODE_ID, ADMIN_KEY } = require('./config');
const routes = require('./routes');

const app = express();
app.use(express.json());

// Change this to true to prevent RAM exhaustion
app.use(fileUpload({ 
    useTempFiles: true, 
    tempFileDir: '/tmp/' 
}));

mongoose.connect(MONGODB_URI);

app.use('/', routes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\n🔧 Sub-Instance [${NODE_ID}] listening on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔑 Login: http://localhost:${PORT}/`);
    console.log(`💡 Use admin key: ${ADMIN_KEY}\n`);
});