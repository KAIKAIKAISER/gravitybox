import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Pack PNG buffers into a standard multi-resolution Windows .ico container (Vista+ PNG-in-ICO).
 */
export function packPngBuffersToIco(frames) {
  const count = frames.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (icon)
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(dirEntrySize);
    const dim = size >= 256 ? 0 : size;
    entry.writeUInt8(dim, 0); // width
    entry.writeUInt8(dim, 1); // height
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...frames.map(f => f.png)]);
}

function resizePngWindows(srcPngPath, outPngPath, size) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile($env:GB_ICO_SRC)`,
    `$bmp = New-Object System.Drawing.Bitmap(${size}, ${size})`,
    `$bmp.SetResolution(96, 96)`,
    `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic`,
    `$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality`,
    `$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality`,
    `$g.DrawImage($src, 0, 0, ${size}, ${size})`,
    `$bmp.Save($env:GB_ICO_OUT, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `$g.Dispose(); $bmp.Dispose(); $src.Dispose()`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, GB_ICO_SRC: srcPngPath, GB_ICO_OUT: outPngPath },
    windowsHide: true,
  });
}

export async function generateWindowsIcons() {
  const masterPng = join(root, 'assets', 'master-1024.png');
  const outIco = join(root, 'assets', 'icons', 'app.ico');
  const outTrayPng = join(root, 'assets', 'icons', 'tray.png');
  const tmpDir = join(root, '.cache', 'ico-tmp');
  mkdirSync(dirname(outIco), { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const sizes = [256, 64, 48, 32, 16];
  const frames = [];
  for (const size of sizes) {
    const outPath = join(tmpDir, `icon-${size}.png`);
    resizePngWindows(masterPng, outPath, size);
    const png = readFileSync(outPath);
    frames.push({ size, png });
    if (size === 32) {
      writeFileSync(outTrayPng, png);
    }
  }
  const ico = packPngBuffersToIco(frames);
  writeFileSync(outIco, ico);
  return { outIco, outTrayPng, bytes: ico.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateWindowsIcons().then(res => {
    console.log(`Generated ${res.outIco} (${res.bytes} bytes) and ${res.outTrayPng}`);
  });
}
