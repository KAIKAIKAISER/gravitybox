import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsarArchive } from '../dist/asar.js';
import {
  applyDeepAsarLocalization,
  compileRuntimeFromPack,
  hasAsarLocalizationTag,
  inspectDeepLocalizationStatus,
  loadZhPack,
  patchAsarArchive,
  restoreOfficialAsar,
} from '../dist/asar-patcher.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetsDir = join(root, 'assets');

function buildSyntheticAsarBuffer(filesMap, unpackedFiles = {}) {
  const fileEntries = {};
  const payloadChunks = [];
  let nextOffset = 0;

  function addNode(rootObj, relPath, buf, isUnpacked = false) {
    const parts = relPath.split('/');
    let cur = rootObj;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!cur[seg]) cur[seg] = { files: {} };
      cur = cur[seg].files;
    }
    const leaf = parts[parts.length - 1];
    if (isUnpacked) {
      cur[leaf] = { size: buf.length, unpacked: true };
    } else {
      const hash = createHash('sha256').update(buf).digest('hex');
      cur[leaf] = {
        size: buf.length,
        offset: String(nextOffset),
        integrity: { algorithm: 'SHA256', hash, blockSize: 4194304, blocks: [hash] },
      };
      payloadChunks.push(buf);
      nextOffset += buf.length;
    }
  }

  for (const [rel, buf] of Object.entries(filesMap)) {
    addNode(fileEntries, rel, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'), false);
  }
  for (const [rel, buf] of Object.entries(unpackedFiles)) {
    addNode(fileEntries, rel, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'), true);
  }

  const jsonBuf = Buffer.from(JSON.stringify({ files: fileEntries }), 'utf8');
  const alignedInner = Math.ceil((4 + jsonBuf.length) / 4) * 4;
  const headerSize = 4 + alignedInner;
  const padBytes = alignedInner - 4 - jsonBuf.length;

  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(alignedInner, 8);
  prefix.writeUInt32LE(jsonBuf.length, 12);

  return Buffer.concat([prefix, jsonBuf, Buffer.alloc(padBytes, 0), ...payloadChunks]);
}

test('assets/zh-pack.json 可加载且可编译为语法合法运行时脚本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-zhpack-'));
  try {
    const { pack, source } = await loadZhPack(dir, assetsDir);
    assert.equal(source, 'bundled');
    assert.equal(pack.schema, 1);
    assert.ok(pack.entriesCount > 2000);
    assert.equal(pack.entries['Model'], '模型');
    assert.equal(pack.entries['Skill'], undefined);
    const compiled = compileRuntimeFromPack(pack, false);
    assert.ok(compiled.includes('ANTIGRAVITY CHINESE LOCALIZATION START'));
    assert.ok(compiled.includes('__ANTIGRAVITY_OBSERVER__'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('纯 Node ASAR 补丁器：保留 unpacked 与未改动文件，注入并可完整还原原版', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gb-asar-patch-'));
  try {
    const appDir = join(work, 'app');
    const resDir = join(appDir, 'resources');
    const stateDir = join(work, 'state');
    await mkdir(resDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const originalMainJs = [
      'const electron_1 = require("electron");',
      'electron_1.app.on(\'web-contents-created\', (_event, contents) => {',
      '  console.log(contents.getType());',
      '});',
      'const quitOpts = { buttons: [\'Cancel\', \'Quit\'],\n        defaultId: 1,\n        cancelId: 0,\n        title: \'Confirm Quit\',\n        message: \'Are you sure you want to quit?\',\n        detail: \'There may be agents or background tasks running.\', };',
    ].join('\n');

    const rawAsar = buildSyntheticAsarBuffer(
      {
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.32.2' }),
        'dist/preload.js': 'console.log("official preload");\n',
        'dist/main.js': originalMainJs,
        'dist/menu.js': 'const menu = { items: [] }; electron_1.Menu.setApplicationMenu(menu);',
        'dist/tray.js': 'exports.createTray = function() {};',
        'dist/loadingOverlay.js': 'const x = \'<div class="label">Loading</div>\';',
      },
      {
        'node_modules/chrome-devtools-mcp/index.js': '// unpacked native helper',
      }
    );

    const asarPath = join(resDir, 'app.asar');
    await writeFile(asarPath, rawAsar);

    assert.equal(hasAsarLocalizationTag(appDir), false);
    const beforeStatus = await inspectDeepLocalizationStatus(appDir, stateDir, assetsDir);
    assert.equal(beforeStatus.appFound, true);
    assert.equal(beforeStatus.isPatched, false);
    assert.equal(beforeStatus.appVersion, '2.32.2');

    // 测试 patchAsarArchive 独立保留 unpacked 与原文件
    const customOut = join(work, 'custom.asar');
    await patchAsarArchive(asarPath, customOut, new Map([['dist/custom.txt', Buffer.from('hello', 'utf8')]]));
    const checkCustom = await openAsarArchive(customOut);
    try {
      const unpackedEntry = checkCustom.header.files?.node_modules?.files?.['chrome-devtools-mcp']?.files?.['index.js'];
      assert.equal(unpackedEntry?.unpacked, true);
      const customEntry = checkCustom.header.files?.dist?.files?.['custom.txt'];
      assert.ok(customEntry);
      assert.equal((await checkCustom.readEntryBuffer(customEntry, 100, 1))?.toString('utf8'), 'hello');
      const preloadEntry = checkCustom.header.files?.dist?.files?.['preload.js'];
      assert.equal((await checkCustom.readEntryBuffer(preloadEntry, 1000, 1))?.toString('utf8'), 'console.log("official preload");\n');
    } finally {
      await checkCustom.close();
    }

    // 应用全量深度汉化
    const applyRes = await applyDeepAsarLocalization(appDir, stateDir, assetsDir);
    assert.equal(applyRes.ok, true);
    assert.equal(hasAsarLocalizationTag(appDir), true);
    assert.equal(existsSync(join(resDir, 'app.asar.bak')), true);

    const afterStatus = await inspectDeepLocalizationStatus(appDir, stateDir, assetsDir);
    assert.equal(afterStatus.isPatched, true);
    assert.equal(afterStatus.hasBackup, true);
    assert.equal(afterStatus.conflictGuardActive, true);

    // 验证 main.js 子框架监听器与退出确认已注入且 unpacked 完好
    const patchedArchive = await openAsarArchive(asarPath);
    try {
      const mainBuf = await patchedArchive.readEntryBuffer(patchedArchive.header.files?.dist?.files?.['main.js'], 5_000_000, 1);
      const mainText = mainBuf?.toString('utf8') ?? '';
      assert.ok(mainText.includes('确认退出'));
      assert.ok(mainText.includes('did-frame-finish-load'));
      assert.ok(mainText.includes('zh_translator_runtime.js'));
      const rtBuf = await patchedArchive.readEntryBuffer(patchedArchive.header.files?.dist?.files?.['zh_translator_runtime.js'], 5_000_000, 1);
      assert.ok((rtBuf?.toString('utf8') ?? '').includes('__ANTIGRAVITY_OBSERVER__'));
      const mcpUnpacked = patchedArchive.header.files?.node_modules?.files?.['chrome-devtools-mcp']?.files?.['index.js'];
      assert.equal(mcpUnpacked?.unpacked, true);
    } finally {
      await patchedArchive.close();
    }

    // 测试从 app.asar.bak 还原官方纯净原版
    const restoreRes = await restoreOfficialAsar(appDir);
    assert.equal(restoreRes.ok, true);
    assert.equal(hasAsarLocalizationTag(appDir), false);
    const restoredRaw = await readFile(asarPath);
    assert.equal(restoredRaw.equals(rawAsar), true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
