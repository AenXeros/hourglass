// Renders build/icon.svg into the raster assets the app + installer need:
//   build/icon.png  (512x512, used by electron-builder / Linux / window icon)
//   build/icon.ico  (multi-resolution Windows icon: 16..256)
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'));

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  // Master 512 PNG
  await sharp(svg, { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(path.join(BUILD, 'icon.png'));

  // Render each size the .ico should contain
  const buffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()
    )
  );

  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);

  console.log('Generated build/icon.png and build/icon.ico');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
