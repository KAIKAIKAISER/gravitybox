import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceDigest, writeSha256Sidecar } from './release-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function packageWindows({ skipBuild = false } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const outputDir = join(root, '成品');
  await mkdir(outputDir, { recursive: true });

  if (!skipBuild) {
    execFileSync(process.execPath, [join(root, 'tools/clean-dist.mjs')], { cwd: root, stdio: 'inherit' });
    const tscBin = join(root, 'node_modules/typescript/bin/tsc');
    execFileSync(process.execPath, [tscBin], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'tools/copy-runtime.mjs')], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'tools/generate-win-ico.mjs')], { cwd: root, stdio: 'inherit' });
  }

  const builderBin = join(root, 'node_modules/electron-builder/cli.js');
  execFileSync(process.execPath, [builderBin, '--win', '--x64', '--publish', 'never'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });

  const setupName = `GravityBox-Setup-${version}-x64.exe`;
  const zipName = `GravityBox-${version}-win-x64.zip`;
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
