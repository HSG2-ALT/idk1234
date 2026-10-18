'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const file = path.join(__dirname, '.env');
if (fs.existsSync(file)) {
  console.log('Your .env already exists and was kept. Start Biscord with npm start.');
} else {
  fs.writeFileSync(file, `PORT=3000\nJWT_SECRET=${crypto.randomBytes(32).toString('hex')}\nMAX_UPLOAD_MB=1024\n`, { mode: 0o600 });
  console.log('Created .env with a random secret. Start Biscord with npm start.');
}
