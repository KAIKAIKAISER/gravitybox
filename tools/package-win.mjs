import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceDigest, writeSha256Sidecar } from './release-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function findMakensis() {
  const candidates = [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
    'C:\\ProgramData\\chocolatey\\bin\\makensis.exe',
    'makensis.exe',
  ];
  for (const cand of candidates) {
    if (cand === 'makensis.exe' || existsSync(cand)) {
      return cand;
    }
  }
  return 'makensis.exe';
}

export async function packageWindows({ skipBuild = false } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const outputDir = join(root, '成品');
  const stageDir = join(root, 'build', 'win-unpacked');

  await mkdir(outputDir, { recursive: true });
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  if (!skipBuild) {
    execFileSync(process.execPath, [join(root, 'tools/clean-dist.mjs')], { cwd: root, stdio: 'inherit' });
    const tscBin = join(root, 'node_modules/typescript/bin/tsc');
    execFileSync(process.execPath, [tscBin], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'tools/copy-runtime.mjs')], { cwd: root, stdio: 'inherit' });
  }
  execFileSync(process.execPath, [join(root, 'tools/generate-win-ico.mjs')], { cwd: root, stdio: 'inherit' });

  // Build ultra-lightweight Rust WebView2 native desktop shell
  execFileSync('cargo', ['build', '--release', '--manifest-path', join(root, 'native-win', 'Cargo.toml')], {
    cwd: root,
    stdio: 'inherit',
  });

  const builtExe = join(root, 'native-win', 'target', 'release', 'GravityBox.exe');
  if (!existsSync(builtExe)) {
    throw new Error(`Missing built Rust binary: ${builtExe}`);
  }

  // Stage minimal portable bundle: Rust shell + single node.exe backend + dist + dict + ui + assets
  await cp(builtExe, join(stageDir, 'GravityBox.exe'));
  await cp(process.execPath, join(stageDir, 'node.exe'));
  await cp(join(root, 'dist'), join(stageDir, 'dist'), { recursive: true });
  await cp(join(root, 'dict'), join(stageDir, 'dict'), { recursive: true });
  await cp(join(root, 'ui'), join(stageDir, 'ui'), { recursive: true });
  await cp(join(root, 'assets'), join(stageDir, 'assets'), {
    recursive: true,
    filter: src => !src.replaceAll('\\', '/').includes('/assets/screenshots'),
  });
  for (const doc of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(join(root, doc))) {
      await cp(join(root, doc), join(stageDir, doc));
    }
  }

  const setupName = `GravityBox-Setup-${version}-x64.exe`;
  const zipName = `GravityBox-${version}-win-x64.zip`;
  const setupPath = join(outputDir, setupName);
  const zipPath = join(outputDir, zipName);
  await rm(setupPath, { force: true });
  await rm(zipPath, { force: true });

  // Portable ZIP via PowerShell Compress-Archive
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path "${stageDir}\\*" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force`,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );

  // Lightweight NSIS installer
  const makensis = findMakensis();
  execFileSync(
    makensis,
    [
      `/DVERSION=${version}`,
      `/DSRCDIR=${stageDir}`,
      `/DOUTFILE=${setupPath}`,
      `/DICON=${join(root, 'assets', 'icons', 'app.ico')}`,
      join(root, 'tools', 'installer.nsi'),
    ],
    { cwd: root, stdio: 'inherit' },
  );

  const artifacts = [];
  for (const name of [setupName, zipName]) {
    const filePath = join(outputDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Missing expected Windows artifact: ${filePath}`);
    }
    const sidecar = await writeSha256Sidecar(filePath);
    artifacts.push({ name, sha256: sidecar.hash, sidecarName: `${name}.sha256` });
  }

  const digest = await sourceDigest(root);
  const manifest = {
    schema: 1,
    platform: 'win32',
    arch: 'x64',
    version,
    tag: `v${version}`,
    sourceDigest: digest,
    artifacts,
    builtAt: new Date().toISOString(),
  };
  await writeFile(join(outputDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skipBuild = process.argv.includes('--skip-build');
  packageWindows({ skipBuild }).then(m => {
    console.log(JSON.stringify(m, null, 2));
  }).catch(err => {
    console.error(`[package-win] ${err.message}`);
    process.exitCode = 1;
  });
}
