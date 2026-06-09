/**
 * build-icons.js — converts the SVG masters in assets/ and downloads/
 * into PNGs at all the sizes the app and website need.
 *
 * Run with:   node tools/build-icons.js
 * (Requires `sharp` — install via `npm install --no-save sharp` if not present.)
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const DOWNLOADS = path.join(ROOT, 'downloads');

async function convert(svgPath, pngPath, width, height = width) {
  if (!fs.existsSync(svgPath)) {
    console.error(`  ✗ missing: ${svgPath}`);
    return;
  }
  const svg = fs.readFileSync(svgPath);
  await sharp(svg, { density: 384 })
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngPath);
  console.log(`  ✓ ${path.relative(ROOT, pngPath)}  (${width}×${height})`);
}

async function main() {
  console.log('Building app assets…');
  await convert(path.join(ASSETS, 'icon.svg'),          path.join(ASSETS, 'icon.png'),          1024);
  await convert(path.join(ASSETS, 'adaptive-icon.svg'), path.join(ASSETS, 'adaptive-icon.png'), 1024);
  await convert(path.join(ASSETS, 'splash-icon.svg'),   path.join(ASSETS, 'splash-icon.png'),   2048);
  await convert(path.join(ASSETS, 'favicon.svg'),       path.join(ASSETS, 'favicon.png'),       64);

  console.log('\nBuilding website downloads…');
  // Icons (multi-size PNG for site / social / press)
  for (const size of [1024, 512, 256, 128]) {
    await convert(path.join(DOWNLOADS, 'overload-icon-dark.svg'), path.join(DOWNLOADS, `overload-icon-dark-${size}.png`), size);
    await convert(path.join(DOWNLOADS, 'overload-icon-lime.svg'), path.join(DOWNLOADS, `overload-icon-lime-${size}.png`), size);
  }
  // Wordmarks
  await convert(path.join(DOWNLOADS, 'overload-wordmark-lime.svg'), path.join(DOWNLOADS, 'overload-wordmark-lime-2048.png'), 2048, 410);
  await convert(path.join(DOWNLOADS, 'overload-wordmark-dark.svg'), path.join(DOWNLOADS, 'overload-wordmark-dark-2048.png'), 2048, 410);
  await convert(path.join(DOWNLOADS, 'overload-wordmark-lime.svg'), path.join(DOWNLOADS, 'overload-wordmark-lime-1024.png'), 1024, 205);
  await convert(path.join(DOWNLOADS, 'overload-wordmark-dark.svg'), path.join(DOWNLOADS, 'overload-wordmark-dark-1024.png'), 1024, 205);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
