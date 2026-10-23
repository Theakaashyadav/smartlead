const path = require('node:path');

// Keep the browser with the installed dependencies when a host moves a build.
module.exports = {
  cacheDirectory: path.join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  // Public Google Sheet updates use Chromium even with socket WhatsApp login.
  chrome: { skipDownload: false },
  'chrome-headless-shell': { skipDownload: true },
};
