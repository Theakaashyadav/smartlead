const path = require('node:path');

// Keep the browser with the installed dependencies when a host moves a build.
module.exports = {
  cacheDirectory: path.join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  'chrome-headless-shell': { skipDownload: true },
};
