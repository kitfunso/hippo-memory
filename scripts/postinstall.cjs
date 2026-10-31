const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.env.HIPPO_SKIP_POSTINSTALL === '1') {
  process.exit(0);
}

const distPostinstall = path.join(__dirname, '..', 'dist', 'postinstall.js');
if (!fs.existsSync(distPostinstall)) {
  process.exit(0);
}

// A failed nudge must not fail the install, but the reason still reaches the user.
import(pathToFileURL(distPostinstall).href).catch((err) => {
  process.stderr.write(`hippo-memory postinstall skipped: ${err instanceof Error ? err.message : err}\n`);
  process.exit(0);
});
