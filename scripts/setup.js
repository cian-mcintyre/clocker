'use strict';

// Copies all ffmpeg.wasm dist files from node_modules into public/vendor/
// so they are served from the same origin — required when COEP headers are set.
// Runs automatically after `npm install` via the postinstall hook.

const fs   = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function copyDir(srcPkg, destDir) {
  const src  = path.join(root, 'node_modules', srcPkg);
  const dest = path.join(root, destDir);
  fs.mkdirSync(dest, { recursive: true });

  let count = 0;
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith('.js') && !file.endsWith('.wasm')) continue;
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
    console.log(`  ✓  ${destDir}/${file}`);
    count++;
  }
  return count;
}

let total = 0;
total += copyDir('@ffmpeg/ffmpeg/dist/esm',  'public/vendor/ffmpeg');
total += copyDir('@ffmpeg/util/dist/esm',    'public/vendor/util');
total += copyDir('@ffmpeg/core-mt/dist/esm', 'public/vendor/core');

console.log(`\nffmpeg.wasm vendor files ready (${total} files)\n`);
