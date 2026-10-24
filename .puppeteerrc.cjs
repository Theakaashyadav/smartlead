const path = require('node:path');

// Keep the browser with the installed dependencies when a host moves a build.
module.exports = {
  cacheDirectory: path.join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  // Google Sheets API and the default socket WhatsApp connection need no browser.
  chrome: { skipDownload: !process.env.WHATSAPP_LOGIN_MODE || process.env.WHATSAPP_LOGIN_MODE === 'socket' },
  'chrome-headless-shell': { skipDownload: true },
};
