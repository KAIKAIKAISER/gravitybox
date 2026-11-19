import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { openAsarArchive, openAsarSync, type AsarFileEntry, type AsarHeader } from './asar.js';
import { extractUiStrings, fetchBuffer, fetchBundleFromOrigin, foldDictionaryKey, isEnglishSource, normalizeText } from './bundle.js';
import { allowedTarget } from './discovery.js';

const execFileAsync = promisify(execFile);

const ASAR_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;
const DEFAULT_ZH_PACK_REPO = 'KAIKAIKAISER/antigravity-zh-asar';
const DEFAULT_TAG_PATH = 'dist/antigravity_zh_cn.tag';

export interface ZhPackReplacementSpec {
  file: string;
  pairs: Array<[string, string, boolean?]>;
}

export interface ZhPackSpec {
  schema: number;
  appVersion: string;
  updatedAt: string;
  entriesCount: number;
  whitelist: string[];
  entries: Record<string, string>;
  runtimeTemplate: string;
  electronPatches: {
    tagName?: string;
    markerStart: string;
    markerEnd: string;
    subframeStart: string;
    subframeEnd: string;
    menuDictionary?: Record<string, string>;
    trayDictionary?: Record<string, string>;
    replacements: ZhPackReplacementSpec[];
  };
}

export interface AsarLocalizationTag {
  schema?: number;
  version?: string;
  updatedAt?: string;
  source?: string;
  entriesCount?: number;
  packUpdatedAt?: string;
}

export interface DeepLocalizationStatus {
  appFound: boolean;
  appVersion?: string;
  resourcesDir?: string;
  asarPath?: string;
  bakPath?: string;
  hasBackup: boolean;
  isPatched: boolean;
  tag?: AsarLocalizationTag;
  zhPackVersion: string;
  zhPackEntriesCount: number;
  zhPackUpdatedAt: string;
  zhPackSource: 'remote-synced' | 'bundled';
  needsReapply: boolean;
  conflictGuardActive: boolean;
}

export interface DeepApplyResult {
  ok: boolean;
  appVersion?: string;
  asarPath?: string;
  patchedFiles: string[];
  entriesCount: number;
  fileLocked?: boolean;
  hotInjectedTargets?: number;
  hotInjectedNodes?: number;
  message: string;
}

export interface PendingScanResult {
  ok: boolean;
  appVersion: string;
  totalExtracted: number;
  pendingCount: number;
  pending: string[];
  pendingFilePath: string;
  promptText: string;
  scannedSources: string[];
}

function withoutElectronAsar<T>(fn: () => T): T {
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const prev = proc.noAsar;
  proc.noAsar = true;
  try {
    return fn();
  } finally {
    proc.noAsar = prev;
  }
}

export function resolveResourcesDir(appPath: string): string | null {
  if (!appPath) return null;
  const normalized = resolve(appPath);
  const candidates = [
    normalized,
    join(normalized, 'resources'),
    join(normalized, 'Contents', 'Resources'),
    dirname(normalized),
    join(dirname(normalized), 'resources'),
  ];
  for (const dir of candidates) {
    if (withoutElectronAsar(() => existsSync(join(dir, 'app.asar')))) {
      return dir;
    }
  }
  return null;
}

function findAsarEntry(header: AsarHeader, relPath: string): AsarFileEntry | undefined {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  let cur: Record<string, AsarFileEntry> | undefined = header.files;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (!cur || !key) return undefined;
    const node = cur[key];
    if (!node) return undefined;
    if (i === parts.length - 1) return node;
    cur = node.files;
  }
  return undefined;
}

export function hasAsarLocalizationTag(appPath: string): boolean {
  const resDir = resolveResourcesDir(appPath);
  if (!resDir) return false;
  const asarPath = join(resDir, 'app.asar');
  try {
    const reader = openAsarSync(asarPath);
    try {
      return Boolean(
        findAsarEntry(reader.header, DEFAULT_TAG_PATH) ||
        findAsarEntry(reader.header, 'antigravity_zh_cn.tag')
      );
    } finally {
      reader.close();
    }
  } catch {
    return false;
  }
}

function computeAsarIntegrity(buf: Buffer): {
  algorithm: 'SHA256';
  hash: string;
  blockSize: number;
  blocks: string[];
} {
  const fullHash = createHash('sha256').update(buf).digest('hex');
  const blocks: string[] = [];
  if (buf.length === 0) {
    blocks.push(fullHash);
  } else {
    for (let off = 0; off < buf.length; off += ASAR_INTEGRITY_BLOCK_SIZE) {
      const slice = buf.subarray(off, Math.min(off + ASAR_INTEGRITY_BLOCK_SIZE, buf.length));
      blocks.push(createHash('sha256').update(slice).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: fullHash,
    blockSize: ASAR_INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

function insertEntryNode(rootFiles: Record<string, AsarFileEntry>, relPath: string, entry: AsarFileEntry): void {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return;
  let cur = rootFiles;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (!cur[seg] || !cur[seg]!.files) {
      cur[seg] = { files: {} };
    }
    cur = cur[seg]!.files!;
  }
  const leaf = parts[parts.length - 1]!;
  cur[leaf] = entry;
}

type CopyPlanItem =
  | { kind: 'buf'; buf: Buffer }
  | { kind: 'copy'; srcOffset: number; size: number };

/** 纯 Node.js 原生 ASAR 补丁与重打包（零外部依赖，保留 unpacked 与原有 SHA256 完整性结构） */
export async function patchAsarArchive(
  srcAsarPath: string,
  destAsarPath: string,
  overrides: Map<string, Buffer>
): Promise<void> {
  const srcArchive = await openAsarArchive(srcAsarPath);
  const newFilesRoot: Record<string, AsarFileEntry> = {};
  const copyPlan: CopyPlanItem[] = [];
  const usedOverrides = new Set<string>();
  let nextOffset = 0;

  try {
    function walk(srcMap: Record<string, AsarFileEntry> | undefined, destMap: Record<string, AsarFileEntry>, prefix: string): void {
      if (!srcMap) return;
      for (const name of Object.keys(srcMap)) {
        const entry = srcMap[name];
        if (!entry) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.files) {
          const subDest: Record<string, AsarFileEntry> = {};
          destMap[name] = { files: subDest };
          walk(entry.files, subDest, rel);
          continue;
        }
        if (entry.unpacked || entry.link !== undefined) {
          destMap[name] = { ...entry };
          continue;
        }
        if (overrides.has(rel)) {
          usedOverrides.add(rel);
          const buf = overrides.get(rel)!;
          destMap[name] = {
            size: buf.length,
            offset: String(nextOffset),
            integrity: computeAsarIntegrity(buf),
          };
          copyPlan.push({ kind: 'buf', buf });
          nextOffset += buf.length;
        } else {
          const origSize = Number(entry.size ?? 0);
          const origRelOff = Number(entry.offset ?? 0);
          const cloned: AsarFileEntry = {
            ...entry,
            size: origSize,
            offset: String(nextOffset),
          };
          destMap[name] = cloned;
          if (origSize > 0) {
            copyPlan.push({ kind: 'copy', srcOffset: srcArchive.dataOffset + origRelOff, size: origSize });
          }
          nextOffset += origSize;
        }
      }
    }

    walk(srcArchive.header.files, newFilesRoot, '');

    for (const [relPath, buf] of overrides.entries()) {
      if (usedOverrides.has(relPath)) continue;
      insertEntryNode(newFilesRoot, relPath, {
        size: buf.length,
        offset: String(nextOffset),
        integrity: computeAsarIntegrity(buf),
      });
      copyPlan.push({ kind: 'buf', buf });
      nextOffset += buf.length;
    }

    const headerObj: AsarHeader = { files: newFilesRoot };
    const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const alignedInnerPayload = Math.ceil((4 + jsonBuf.length) / 4) * 4;
    const headerSize = 4 + alignedInnerPayload;
    const padBytes = alignedInnerPayload - 4 - jsonBuf.length;

    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerSize, 4);
    prefix.writeUInt32LE(alignedInnerPayload, 8);
    prefix.writeUInt32LE(jsonBuf.length, 12);
    const padBuf = Buffer.alloc(padBytes, 0);

    const tmpPath = `${destAsarPath}.tmp-${process.pid}-${Date.now()}`;
    const srcFd = await withoutElectronAsar(() => open(srcAsarPath, 'r'));
    const outFd = await withoutElectronAsar(() => open(tmpPath, 'w'));
    try {
      await outFd.write(prefix);
      await outFd.write(jsonBuf);
      if (padBuf.length > 0) await outFd.write(padBuf);

      const chunkSize = 1024 * 1024;
      const scratchBuf = Buffer.allocUnsafe(chunkSize);
      for (const item of copyPlan) {
        if (item.kind === 'buf') {
          if (item.buf.length > 0) {
            await outFd.write(item.buf);
          }
        } else {
          let remaining = item.size;
          let pos = item.srcOffset;
          while (remaining > 0) {
            const toRead = Math.min(remaining, chunkSize);
            const { bytesRead } = await srcFd.read(scratchBuf, 0, toRead, pos);
            if (bytesRead <= 0) throw new Error(`读取原 ASAR 数据偏移 ${pos} 失败`);
            await outFd.write(scratchBuf, 0, bytesRead);
            remaining -= bytesRead;
            pos += bytesRead;
          }
        }
      }
      await outFd.sync();
    } finally {
      await outFd.close().catch(() => {});
      await srcFd.close().catch(() => {});
    }

    // 验证生成归档头完整性
    const verifyArchive = await openAsarArchive(tmpPath);
    await verifyArchive.close();

    try {
      await withoutElectronAsar(() => rename(tmpPath, destAsarPath));
    } catch (renameErr: any) {
      if (renameErr?.code === 'EBUSY' || renameErr?.code === 'EPERM') {
        try {
          await withoutElectronAsar(() => copyFile(tmpPath, destAsarPath));
        } finally {
          await withoutElectronAsar(() => unlink(tmpPath).catch(() => {}));
        }
      } else {
        try {
          await withoutElectronAsar(() => copyFile(tmpPath, destAsarPath));
        } finally {
          await withoutElectronAsar(() => unlink(tmpPath).catch(() => {}));
        }
      }
    }
  } finally {
    await srcArchive.close();
  }
}

export async function loadZhPack(
  stateDir: string,
  assetsDir: string
): Promise<{ pack: ZhPackSpec; source: 'remote-synced' | 'bundled' }> {
  const remoteFile = join(stateDir, 'zh-pack-latest.json');
  const bundledFile = join(assetsDir, 'zh-pack.json');

  const tryReadPack = async (file: string): Promise<ZhPackSpec | null> => {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as ZhPackSpec;
      if (
        parsed?.schema === 1 &&
        parsed.entries &&
        typeof parsed.runtimeTemplate === 'string' &&
        parsed.runtimeTemplate.includes('{{MAP_JSON}}')
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const remotePack = await tryReadPack(remoteFile);
  const bundledPack = await tryReadPack(bundledFile);
  if (remotePack && bundledPack) {
    const rTime = Date.parse(remotePack.updatedAt || '') || 0;
    const bTime = Date.parse(bundledPack.updatedAt || '') || 0;
    if (rTime >= bTime) {
      return { pack: remotePack, source: 'remote-synced' };
    }
    return { pack: bundledPack, source: 'bundled' };
  }
  if (remotePack) return { pack: remotePack, source: 'remote-synced' };
  if (bundledPack) return { pack: bundledPack, source: 'bundled' };
  throw new Error('未找到有效的深度汉化数据包 (zh-pack.json)');
}

export function compileRuntimeFromPack(pack: ZhPackSpec, isHotInject = false, extraEntries?: Record<string, string>): string {
  const merged: Record<string, string> = { ...pack.entries };
  if (extraEntries) {
    for (const [k, v] of Object.entries(extraEntries)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        merged[k] = v;
      }
    }
  }
  for (const w of pack.whitelist ?? []) {
    delete merged[w];
    delete merged[w.toLowerCase()];
  }
  merged['Model'] = '模型';
  merged['model'] = '模型';
  merged['Models'] = '模型';
  merged['models'] = '模型';
  merged['MODELS'] = '模型';

  const longEntries = Object.entries(merged).sort((a, b) => b[0].length - a[0].length);
  const guard = isHotInject
    ? ''
    : 'if (window.__ANTIGRAVITY_CN_INJECTED__) return;\n    window.__ANTIGRAVITY_CN_INJECTED__ = true;';
  const hotReturn = isHotInject ? 'return "SUCCESS_TRANSLATED_" + translatedCount;' : '';

  return pack.runtimeTemplate
    .replace('{{GUARD}}', guard)
    .replace('{{MAP_JSON}}', JSON.stringify(Object.entries(merged)))
    .replace('{{LONG_JSON}}', JSON.stringify(longEntries))
    .replace('{{HOT_RETURN}}', hotReturn);
}

export async function inspectDeepLocalizationStatus(
  appPath: string,
  stateDir: string,
  assetsDir: string
): Promise<DeepLocalizationStatus> {
  const { pack, source } = await loadZhPack(stateDir, assetsDir);
  const resDir = resolveResourcesDir(appPath);
  if (!resDir) {
    return {
      appFound: false,
      hasBackup: false,
      isPatched: false,
      zhPackVersion: pack.appVersion,
      zhPackEntriesCount: pack.entriesCount ?? Object.keys(pack.entries).length,
      zhPackUpdatedAt: pack.updatedAt,
      zhPackSource: source,
      needsReapply: false,
      conflictGuardActive: false,
    };
  }

  const asarPath = join(resDir, 'app.asar');
  const bakPath = join(resDir, 'app.asar.bak');
  const hasBackup = withoutElectronAsar(() => existsSync(bakPath));

  let appVersion: string | undefined;
  let isPatched = false;
  let tag: AsarLocalizationTag | undefined;

  const reader = await openAsarArchive(asarPath);
  try {
    const pkgEntry = findAsarEntry(reader.header, 'package.json');
    if (pkgEntry) {
      const pkgBuf = await reader.readEntryBuffer(pkgEntry, 1_000_000, 1);
      if (pkgBuf) {
        const pkgJson = JSON.parse(pkgBuf.toString('utf8')) as { version?: string };
        appVersion = pkgJson.version;
      }
    }

    const tagEntry =
      findAsarEntry(reader.header, DEFAULT_TAG_PATH) ||
      findAsarEntry(reader.header, 'antigravity_zh_cn.tag');
    if (tagEntry) {
      isPatched = true;
      const tagBuf = await reader.readEntryBuffer(tagEntry, 500_000, 0);
      if (tagBuf && tagBuf.length > 0) {
        try {
          tag = JSON.parse(tagBuf.toString('utf8')) as AsarLocalizationTag;
        } catch {
          tag = { version: appVersion };
        }
      }
    }
  } finally {
    await reader.close();
  }

  const tagTime = Date.parse(tag?.packUpdatedAt || tag?.updatedAt || '') || 0;
  const packTime = Date.parse(pack.updatedAt || '') || 0;
  const needsReapply =
    !isPatched ||
    (Boolean(appVersion) && Boolean(tag?.version) && tag?.version !== appVersion) ||
    packTime > tagTime;

  return {
    appFound: true,
    appVersion,
    resourcesDir: resDir,
    asarPath,
    bakPath,
    hasBackup,
    isPatched,
    tag,
    zhPackVersion: pack.appVersion,
    zhPackEntriesCount: pack.entriesCount ?? Object.keys(pack.entries).length,
    zhPackUpdatedAt: pack.updatedAt,
    zhPackSource: source,
    needsReapply,
    conflictGuardActive: isPatched,
  };
}

function stripBetweenMarkers(content: string, startMarker: string, endMarker: string): string {
  let out = content;
  while (out.includes(startMarker)) {
    const s = out.indexOf(startMarker);
    const e = out.indexOf(endMarker, s);
    if (e === -1) break;
    out = out.slice(0, s) + out.slice(e + endMarker.length);
  }
  return out;
}

export async function hotInjectActiveAntigravityTargets(
  zhPack: ZhPackSpec,
  port?: number,
  extraEntries?: Record<string, string>
): Promise<{ targets: number; translated: number }> {
  let activePort = port;
  if (!activePort) {
    const candidateFiles = [
      join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort'),
      join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      join(homedir(), '.config', 'Antigravity', 'DevToolsActivePort'),
    ];
    for (const f of candidateFiles) {
      if (f && existsSync(f)) {
        try {
          const first = (await readFile(f, 'utf8')).trim().split(/\r?\n/)[0] || '';
          const p = parseInt(first, 10);
          if (p > 0) {
            activePort = p;
            break;
          }
        } catch {}
      }
    }
  }
  if (!activePort) return { targets: 0, translated: 0 };

  let targets: Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }> = [];
  try {
    const res = await fetch(`http://127.0.0.1:${activePort}/json`, { signal: AbortSignal.timeout(3000) });
    targets = (await res.json()) as typeof targets;
  } catch {
    return { targets: 0, translated: 0 };
  }

  const eligible = targets.filter(
    t =>
      Boolean(t.webSocketDebuggerUrl) &&
      (t.type === 'page' || (t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('plugin://')))
  );
  if (eligible.length === 0) return { targets: 0, translated: 0 };

  const injectionCode = compileRuntimeFromPack(zhPack, true, extraEntries);
  let injectedCount = 0;
  let translatedTotal = 0;

  await Promise.all(
    eligible.map(
      target =>
        new Promise<void>(resolveTarget => {
          const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (!WebSocketCtor) {
            resolveTarget();
            return;
          }
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolveTarget();
            }
          };
          const timer = setTimeout(finish, 5000);
          try {
            const ws = new WebSocketCtor(target.webSocketDebuggerUrl!);
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  id: 1,
                  method: 'Runtime.evaluate',
                  params: { expression: injectionCode, returnByValue: true },
                })
              );
            };
            ws.onmessage = evt => {
              try {
                const msg = JSON.parse(String(evt.data));
                if (msg.id === 1) {
                  injectedCount++;
                  const val = String(msg?.result?.result?.value ?? '');
                  const m = val.match(/SUCCESS_TRANSLATED_(\d+)/);
                  if (m) translatedTotal += Number(m[1]);
                  clearTimeout(timer);
                  try { ws.close(); } catch {}
                  finish();
                }
              } catch {}
            };
            ws.onerror = () => {
              clearTimeout(timer);
              try { ws.close(); } catch {}
              finish();
            };
          } catch {
            clearTimeout(timer);
            finish();
          }
        })
    )
  );

  return { targets: injectedCount, translated: translatedTotal };
}

export async function applyDeepAsarLocalization(
  appPath: string,
  stateDir: string,
  assetsDir: string,
  options: { devToolsPort?: number; extraEntries?: Record<string, string> } = {}
): Promise<DeepApplyResult> {
  const resDir = resolveResourcesDir(appPath);
  if (!resDir) {
    return {
      ok: false,
      patchedFiles: [],
      entriesCount: 0,
      message: '未找到 Antigravity 安装目录与 resources/app.asar',
    };
  }

  const { pack } = await loadZhPack(stateDir, assetsDir);
  const asarPath = join(resDir, 'app.asar');
  const bakPath = join(resDir, 'app.asar.bak');
  const backupsDir = join(stateDir, 'backups');
  await mkdir(backupsDir, { recursive: true });
  const stateOriginalPath = join(backupsDir, 'app.asar.original');

  // 检查当前 app.asar 是否纯净，维护双备份
  let currentVersion = 'unknown';
  let currentIsPure = false;
  let bakMatchesCurrentVersion = false;

  const inspectCurrent = await openAsarArchive(asarPath);
  try {
    const pkgEntry = findAsarEntry(inspectCurrent.header, 'package.json');
    if (pkgEntry) {
      const b = await inspectCurrent.readEntryBuffer(pkgEntry, 1_000_000, 1);
      if (b) currentVersion = (JSON.parse(b.toString('utf8')) as { version?: string }).version ?? 'unknown';
    }
    const tagEntry =
      findAsarEntry(inspectCurrent.header, DEFAULT_TAG_PATH) ||
      findAsarEntry(inspectCurrent.header, 'antigravity_zh_cn.tag');
    currentIsPure = !tagEntry;
  } finally {
    await inspectCurrent.close();
  }

  if (currentIsPure || !withoutElectronAsar(() => existsSync(bakPath))) {
    await withoutElectronAsar(() => copyFile(asarPath, bakPath));
    await withoutElectronAsar(() => copyFile(asarPath, stateOriginalPath));
  } else if (withoutElectronAsar(() => existsSync(bakPath))) {
    try {
      const bakArchive = await openAsarArchive(bakPath);
      try {
        const pkgEntry = findAsarEntry(bakArchive.header, 'package.json');
        if (pkgEntry) {
          const b = await bakArchive.readEntryBuffer(pkgEntry, 1_000_000, 1);
          const bakVer = b ? (JSON.parse(b.toString('utf8')) as { version?: string }).version : undefined;
          const bakPure = !findAsarEntry(bakArchive.header, DEFAULT_TAG_PATH);
          if (bakPure && bakVer === currentVersion) {
            bakMatchesCurrentVersion = true;
          }
        }
      } finally {
        await bakArchive.close();
      }
    } catch {}
  }

  const sourceAsarPath = bakMatchesCurrentVersion ? bakPath : asarPath;
  const srcArchive = await openAsarArchive(sourceAsarPath);
  const overrides = new Map<string, Buffer>();
  const patchedFiles: string[] = [];

  const readSrcText = async (rel: string): Promise<string | null> => {
    const entry = findAsarEntry(srcArchive.header, rel);
    if (!entry) return null;
    const buf = await srcArchive.readEntryBuffer(entry, 15_000_000, 0);
    return buf ? buf.toString('utf8') : null;
  };

  try {
    const spec = pack.electronPatches;
    const runtimeStandalone = compileRuntimeFromPack(pack, false, options.extraEntries);

    // 1. dist/preload.js
    const preloadRaw = await readSrcText('dist/preload.js');
    if (preloadRaw === null) {
      throw new Error('原 app.asar 中缺少 dist/preload.js');
    }
    const cleanPreload = stripBetweenMarkers(preloadRaw, spec.markerStart, spec.markerEnd).trimEnd();
    const patchedPreload = `${cleanPreload}\n\n${runtimeStandalone}`;
    new Script(patchedPreload, { filename: 'dist/preload.js' });
    overrides.set('dist/preload.js', Buffer.from(patchedPreload, 'utf8'));
    patchedFiles.push('dist/preload.js');

    // 2. dist/zh_translator_runtime.js (供 plugin:// 子框架注入)
    new Script(runtimeStandalone, { filename: 'dist/zh_translator_runtime.js' });
    overrides.set('dist/zh_translator_runtime.js', Buffer.from(runtimeStandalone, 'utf8'));
    patchedFiles.push('dist/zh_translator_runtime.js');

    // 3. dist/main.js（退出确认、WSL 提示、plugin:// 子框架监听器）
    const mainRaw = await readSrcText('dist/main.js');
    if (mainRaw !== null) {
      let mainContent = stripBetweenMarkers(mainRaw, spec.subframeStart, spec.subframeEnd);
      const mainSpec = spec.replacements.find(r => r.file === 'dist/main.js');
      if (mainSpec) {
        for (const [from, to, all] of mainSpec.pairs) {
          mainContent = all ? mainContent.split(from).join(to) : mainContent.replace(from, to);
        }
      }
      const hookTarget = "electron_1.app.on('web-contents-created', (_event, contents) => {";
      if (mainContent.includes(hookTarget)) {
        const snippet = `${hookTarget}
    ${spec.subframeStart}
    contents.on('did-frame-finish-load', (_frameEvent, isMainFrame, frameProcessId, frameRoutingId) => {
        try {
            if (isMainFrame) return;
            const frame = electron_1.webFrameMain && electron_1.webFrameMain.fromId(frameProcessId, frameRoutingId);
            if (frame && frame.url && frame.url.startsWith('plugin://')) {
                if (!global.__zhSubframeRuntimeCache) {
                    const rtFile = path.join(__dirname, 'zh_translator_runtime.js');
                    if (fs.existsSync(rtFile)) global.__zhSubframeRuntimeCache = fs.readFileSync(rtFile, 'utf-8');
                }
                if (global.__zhSubframeRuntimeCache) {
                    frame.executeJavaScript(global.__zhSubframeRuntimeCache).catch(() => {});
                }
            }
        } catch (_) {}
    });
    ${spec.subframeEnd}`;
        mainContent = mainContent.replace(hookTarget, snippet);
      }
      new Script(mainContent, { filename: 'dist/main.js' });
      overrides.set('dist/main.js', Buffer.from(mainContent, 'utf8'));
      patchedFiles.push('dist/main.js');
    }

    // 4. dist/menu.js
    const menuRaw = await readSrcText('dist/menu.js');
    if (menuRaw !== null) {
      let menuContent = stripBetweenMarkers(menuRaw, spec.markerStart, spec.markerEnd);
      const menuDictJson = JSON.stringify(spec.menuDictionary ?? {});
      const menuPatch = `
    ${spec.markerStart}
    try {
        const menuTranslations = ${menuDictJson};
        function translateMenu(items) {
            if (!items) return;
            for (const item of items) {
                let label = item.label || '';
                let mnemonic = '';
                let cleanLabel = label;
                const m = label.match(/&([a-zA-Z])/);
                if (m) {
                    mnemonic = "(&" + m[1] + ")";
                    cleanLabel = label.replace('&', '');
                }
                if (menuTranslations[cleanLabel]) item.label = menuTranslations[cleanLabel] + mnemonic;
                else if (menuTranslations[label]) item.label = menuTranslations[label];
                else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                    item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? "版本 " + v : "版本");
                }
                if (item.submenu && item.submenu.items) translateMenu(item.submenu.items);
            }
        }
        if (!electron_1.Menu.__zh_patched) {
            electron_1.Menu.__zh_patched = true;
            const _origSetAppMenu = electron_1.Menu.setApplicationMenu;
            electron_1.Menu.setApplicationMenu = function(m) {
                if (m && m.items) translateMenu(m.items);
                return _origSetAppMenu.call(electron_1.Menu, m);
            };
        }
        translateMenu(menu.items);
    } catch (e) {}
    ${spec.markerEnd}
`;
      const setMenuTarget = 'electron_1.Menu.setApplicationMenu(menu);';
      if (menuContent.includes(setMenuTarget)) {
        menuContent = menuContent.replace(setMenuTarget, menuPatch + '\n    ' + setMenuTarget);
      }
      new Script(menuContent, { filename: 'dist/menu.js' });
      overrides.set('dist/menu.js', Buffer.from(menuContent, 'utf8'));
      patchedFiles.push('dist/menu.js');
    }

    // 5. dist/tray.js
    const trayRaw = await readSrcText('dist/tray.js');
    if (trayRaw !== null) {
      let trayContent = stripBetweenMarkers(trayRaw, spec.markerStart, spec.markerEnd).trimEnd();
      const trayDictJson = JSON.stringify(spec.trayDictionary ?? {});
      const trayPatch = `
${spec.markerStart}
try {
    const _origSetContextMenu = electron_1.Tray.prototype.setContextMenu;
    const trayDict = ${trayDictJson};
    function translateTrayItems(items) {
        if (!items) return;
        for (const it of items) {
            let l = it.label || '';
            if (trayDict[l]) it.label = trayDict[l];
            else if (/^Open\\s+(.+)$/i.test(l)) it.label = l.replace(/^Open\\s+(.+)$/i, '打开 $1');
            else if (/^(\\d+)\\s+agents?\\s+running$/i.test(l)) it.label = l.replace(/^(\\d+)\\s+agents?\\s+running$/i, '$1 个智能体运行中');
            if (it.submenu && it.submenu.items) translateTrayItems(it.submenu.items);
        }
    }
    electron_1.Tray.prototype.setContextMenu = function(menu) {
        if (menu && menu.items) translateTrayItems(menu.items);
        return _origSetContextMenu.call(this, menu);
    };
} catch(e) {}
${spec.markerEnd}
`;
      trayContent = `${trayContent}\n${trayPatch}`;
      new Script(trayContent, { filename: 'dist/tray.js' });
      overrides.set('dist/tray.js', Buffer.from(trayContent, 'utf8'));
      patchedFiles.push('dist/tray.js');
    }

    // 6. 其余 Electron 原生渲染/对话框文件
    for (const item of spec.replacements) {
      if (item.file === 'dist/main.js') continue;
      const raw = await readSrcText(item.file);
      if (raw === null) continue;
      let modified = raw;
      for (const [from, to, all] of item.pairs) {
        modified = all ? modified.split(from).join(to) : modified.replace(from, to);
      }
      if (item.file.endsWith('.js')) {
        new Script(modified, { filename: item.file });
      }
      overrides.set(item.file, Buffer.from(modified, 'utf8'));
      patchedFiles.push(item.file);
    }

    // 7. 写入标记文件
    const tagPayload: AsarLocalizationTag = {
      schema: 1,
      version: currentVersion,
      updatedAt: new Date().toISOString(),
      packUpdatedAt: pack.updatedAt,
      source: 'GravityBox Deep Localization System',
      entriesCount: pack.entriesCount ?? Object.keys(pack.entries).length,
    };
    overrides.set(DEFAULT_TAG_PATH, Buffer.from(JSON.stringify(tagPayload, null, 2), 'utf8'));
    patchedFiles.push(DEFAULT_TAG_PATH);
  } finally {
    await srcArchive.close();
  }

  // 打包写入 app.asar，并处理 Windows 上运行中进程可能产生的 EBUSY
  let fileLocked = false;
  try {
    await patchAsarArchive(sourceAsarPath, asarPath, overrides);
  } catch (err: any) {
    if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
      fileLocked = true;
    } else {
      throw err;
    }
  }

  // 对当前正在运行中的窗口执行热注入（含 plugin:// 子框架）
  const hotResult = await hotInjectActiveAntigravityTargets(pack, options.devToolsPort, options.extraEntries);

  const count = pack.entriesCount ?? Object.keys(pack.entries).length;
  return {
    ok: !fileLocked || hotResult.targets > 0,
    appVersion: currentVersion,
    asarPath,
    patchedFiles,
    entriesCount: count,
    fileLocked,
    hotInjectedTargets: hotResult.targets,
    hotInjectedNodes: hotResult.translated,
    message: fileLocked
      ? `app.asar 正在被占用未能覆写，但已热注入 ${hotResult.targets} 个活跃窗口；请重启 Antigravity 或关闭后再点击写入。`
      : `已完成 v${currentVersion} 深度汉化打包（注入 ${patchedFiles.length} 个模块，词库 ${count} 条），并热生效 ${hotResult.targets} 个窗口。`,
  };
}

export async function restoreOfficialAsar(appPath: string): Promise<{ ok: boolean; message: string }> {
  const resDir = resolveResourcesDir(appPath);
  if (!resDir) return { ok: false, message: '未找到 Antigravity 资源目录' };
  const asarPath = join(resDir, 'app.asar');
  const bakPath = join(resDir, 'app.asar.bak');
  if (!withoutElectronAsar(() => existsSync(bakPath))) {
    return { ok: false, message: '未找到官方原版备份 (app.asar.bak)' };
  }
  await withoutElectronAsar(() => copyFile(bakPath, asarPath));
  return { ok: true, message: '已从 app.asar.bak 恢复官方纯净原版' };
}

export async function syncRemoteZhPack(
  stateDir: string,
  options: { repo?: string } = {}
): Promise<{ ok: boolean; pack?: ZhPackSpec; via?: string; message: string }> {
  const repo = options.repo || DEFAULT_ZH_PACK_REPO;
  await mkdir(stateDir, { recursive: true });
  const destPath = join(stateDir, 'zh-pack-latest.json');
  const tmpFile = join(stateDir, `zh-pack-dl-${Date.now()}.json`);

  const validatePack = (raw: string): ZhPackSpec => {
    const parsed = JSON.parse(raw) as ZhPackSpec;
    if (
      parsed?.schema !== 1 ||
      !parsed.entries ||
      typeof parsed.runtimeTemplate !== 'string' ||
      !parsed.runtimeTemplate.includes('{{MAP_JSON}}')
    ) {
      throw new Error('云端 zh-pack.json 格式校验失败');
    }
    const rendered = compileRuntimeFromPack(parsed, false);
    new Script(rendered, { filename: 'remote-zh-pack-check.js' });
    return parsed;
  };

  // 方式 1：优先尝试 gh CLI（自动认证，支持私有与公有仓库）
  try {
    await execFileAsync(
      'gh',
      ['release', 'download', 'latest', '-R', repo, '-p', 'zh-pack.json', '-O', tmpFile],
      { timeout: 25000, windowsHide: true }
    );
    const raw = await readFile(tmpFile, 'utf8');
    const pack = validatePack(raw);
    await rename(tmpFile, destPath);
    return {
      ok: true,
      pack,
      via: 'gh-release',
      message: `已从 GitHub (${repo}) 同步最新汉化包 (v${pack.appVersion}, ${pack.entriesCount} 条词库)`,
    };
  } catch {
    await unlink(tmpFile).catch(() => {});
  }

  // 方式 2：公开 HTTPS Release 下载回退
  const urls = [
    `https://github.com/${repo}/releases/latest/download/zh-pack.json`,
    `https://raw.githubusercontent.com/${repo}/main/zh-pack.json`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const raw = await res.text();
      const pack = validatePack(raw);
      await writeFile(destPath, JSON.stringify(pack, null, 2), 'utf8');
      return {
        ok: true,
        pack,
        via: 'https',
        message: `已通过 HTTPS 同步最新汉化包 (v${pack.appVersion}, ${pack.entriesCount} 条词库)`,
      };
    } catch {}
  }

  return {
    ok: false,
    message: `无法从 ${repo} 拉取 zh-pack.json，请确认网络连接或已在终端通过 gh auth login 登录授权。`,
  };
}

const KNOWN_DYNAMIC_REGEXES = [
  /^(\d+) tools? in this MCP server \(([^)]+) tokens\) exceeded/i,
  /^(\d+) MCP servers? failed to start$/i,
  /^Can't access "(.+?)"\. macOS privacy settings/i,
  /^I am ([^.]+)\. I coordinate the work for this project/i,
  /^paused:\s*(quota|error)$/i,
  /^The narrator's last step failed:/i,
  /^the narrator's view failed/i,
  /^(\d+) (?:posts?|members?|tasks?|hidden hosts?|accounts?|matching bundles?|tools? disabled)$/i,
  /^(\d+) of (\d+) tasks? done$/i,
  /^(?:From|To) [a-zA-Z0-9_@-]{1,30}$/,
  /^@([a-zA-Z0-9_-]+) (?:ran out of quota|looks stuck|hit an error)$/i,
  /^Opening (.+?)'s conversation needs the app\.$/i,
  /^(.+?) runs on (.+?); open it there\.$/i,
  /^seen (\d+)([smhd]) ago$/i,
  /^(?:Couldn't connect to|No hosts in|Remove .+ from Recent|Removed .+ from Recent|Couldn't remove .+ from Recent)/i,
  /^(?:Stop the Antigravity server on|Sign in to your organization for)/i,
  /^(?:Hidden by policy|Reconnecting to|Disconnected from|Agents keep running on)/i,
  /^(?:Where the agent runs, current:|Select project, current:|Select model, current:)/i,
  /^(?:Showing first \d+ references|No connectors match|Yes, allow|Yes, save rule|Yes, and always allow)/i,
  /^(?:Managed by the .+ plugin|Microphone access for .+ was denied|Side question \(conversation)/i,
  /^(?:NAVIGATION_BLOCKED:|Open .+ settings|See all \(\d+\)|Thought for \d+s)/i,
];

function isCleanPendingUiText(s: string): boolean {
  if (/[\u4e00-\u9fff]/.test(s)) return false;
  if (!isEnglishSource(s)) return false;
  if (s.length < 2 || s.length > 220) return false;
  if (/[{};]|=>|function\s*\(|return\s+/.test(s)) return false;
  if (/^(?:flex|grid|inline-|block|hidden|relative|absolute|fixed|sticky|text-|bg-|border-|rounded|px-|py-|mt-|mb-|ml-|mr-|gap-|w-|h-|min-|max-|overflow-|pointer-events-|select-|transition-|opacity-|cursor-)/.test(s)) {
    return false;
  }
  if (/^(?:M\d|L\d|C\d|rgb\(|rgba\(|hsl\(|var\(--|calc\(|cubic-bezier\()/i.test(s)) return false;
  if (/^--[a-z0-9-]+$/i.test(s)) return false;
  if (/^[a-z0-9_-]+(?:\s+[a-z0-9_-]+)*$/.test(s) && s.includes('-')) return false;
  if (KNOWN_DYNAMIC_REGEXES.some(re => re.test(s))) return false;
  return true;
}

export async function scanPendingForWorkflowA(
  appPath: string,
  stateDir: string,
  assetsDir: string,
  options: { devToolsPort?: number; appVersion?: string } = {}
): Promise<PendingScanResult> {
  const { pack } = await loadZhPack(stateDir, assetsDir);
  const foldedDict = new Set<string>();
  for (const k of Object.keys(pack.entries)) {
    foldedDict.add(foldDictionaryKey(k));
  }
  for (const w of pack.whitelist ?? []) {
    foldedDict.add(foldDictionaryKey(w));
  }

  let detectedVersion = options.appVersion || pack.appVersion;
  const scannedSources: string[] = [];
  const rawSet = new Set<string>();

  // 1. 扫描运行时前端 main.js
  let activePort = options.devToolsPort;
  if (!activePort) {
    const portFile = join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
    if (portFile && existsSync(portFile)) {
      try {
        activePort = parseInt((await readFile(portFile, 'utf8')).trim().split(/\r?\n/)[0] || '', 10) || undefined;
      } catch {}
    }
  }
  if (activePort) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${activePort}/json/list`, { signal: AbortSignal.timeout(3000) });
      const targets = (await targetsRes.json()) as Array<{ type?: string; url?: string }>;
      const mainTarget = targets.find((t): t is { type: string; url: string } => typeof t.type === 'string' && typeof t.url === 'string' && allowedTarget({ type: t.type, url: t.url }));
      if (mainTarget) {
        const origin = new URL(mainTarget.url).origin;
        const bundleSrc = await fetchBundleFromOrigin(origin, 12000);
        const indexHtml = (await fetchBuffer(`${origin}/index.html`, 5000)).toString('utf8');
        const mVer = indexHtml.match(/"appVersion":"([^"]+)"/);
        if (mVer && mVer[1]) detectedVersion = mVer[1];

        const extracted = extractUiStrings(bundleSrc);
        for (const item of extracted) {
          if (item.kinds.includes('ui') || item.kinds.includes('text') || item.kinds.includes('literal')) {
            rawSet.add(normalizeText(item.text));
          }
        }
        scannedSources.push('frontend:main.js');
      }
    } catch {}
  }

  // 2. 扫描本地 app.asar 中 dist/*.js 关键界面文言（优先扫描同版本官方备份 app.asar.bak 以避免扫描到自身补丁）
  const resDir = resolveResourcesDir(appPath);
  if (resDir) {
    try {
      const bakCandidate = join(resDir, 'app.asar.bak');
      const scanAsarPath = withoutElectronAsar(() => existsSync(bakCandidate)) ? bakCandidate : join(resDir, 'app.asar');
      const archive = await openAsarArchive(scanAsarPath);
      try {
        const scanEntries = (files: Record<string, AsarFileEntry> | undefined, prefix: string): string[] => {
          const out: string[] = [];
          if (!files) return out;
          for (const [name, entry] of Object.entries(files)) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (entry.files) out.push(...scanEntries(entry.files, p));
            else if (p.startsWith('dist/') && p.endsWith('.js') && !p.includes('__mocks__')) out.push(p);
          }
          return out;
        };
        const jsFiles = scanEntries(archive.header.files, '');
        for (const rel of jsFiles) {
          const entry = findAsarEntry(archive.header, rel);
          if (!entry) continue;
          const buf = await archive.readEntryBuffer(entry, 2_000_000, 1);
          if (!buf) continue;
          const src = buf.toString('utf8');
          for (const m of src.matchAll(/(?:title|message|detail|label)\s*:\s*(?:'((?:[^'\\]|\\.){2,140})'|"((?:[^"\\]|\\.){2,140})")/g)) {
            const rawStr = m[1] ?? m[2];
            if (rawStr) {
              const unescaped = rawStr.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
              rawSet.add(normalizeText(unescaped));
            }
          }
        }
        scannedSources.push(`app.asar:dist (${jsFiles.length} files)`);
      } finally {
        await archive.close();
      }
    } catch {}
  }

  // 3. 扫描内置插件 HTML/JS (如 swarm_board)
  const builtinPluginsDir = join(homedir(), '.gemini', 'antigravity', 'builtin', 'plugins');
  if (existsSync(builtinPluginsDir)) {
    try {
      const scanPluginDir = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await scanPluginDir(full);
          else if (entry.name.endsWith('.html') || entry.name.endsWith('.js')) {
            const content = await readFile(full, 'utf8');
            for (const m of content.matchAll(/>([A-Z][^<>\r\n]{1,120})</g)) {
              if (m[1]) {
                const decoded = m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                rawSet.add(normalizeText(decoded));
              }
            }
          }
        }
      };
      await scanPluginDir(builtinPluginsDir);
      scannedSources.push('builtin-plugins');
    } catch {}
  }

  const pending: string[] = [];
  for (const s of rawSet) {
    if (!isCleanPendingUiText(s)) continue;
    const fk = foldDictionaryKey(s);
    if (foldedDict.has(fk)) continue;
    pending.push(s);
  }
  pending.sort();

  const reportsDir = join(stateDir, 'reports');
  await mkdir(reportsDir, { recursive: true });
  const pendingFilePath = join(reportsDir, `pending-workflow-a-${detectedVersion}.json`);
  const payload = {
    schema: 1,
    appVersion: detectedVersion,
    generatedAt: new Date().toISOString(),
    scannedSources,
    pendingCount: pending.length,
    strings: pending,
  };
  await writeFile(pendingFilePath, JSON.stringify(payload, null, 2), 'utf8');

  const promptText = [
    `请帮我按 Antigravity 汉化白名单规范（保留 Skill/Skills/Token/Tokens/LLM/Prompt/MCP/New/+ New/Notice/Note/High/Medium/Low/Fast/Turbo 原文，将 Model/Models 译为“模型”）翻译以下 v${detectedVersion} 新增文本（共 ${pending.length} 条），写入 tools/dicts/ 并运行 apply_localization.js 编译发布到 GitHub Release：`,
    '',
    '```json',
    JSON.stringify(pending.slice(0, 120), null, 2),
    '```',
  ].join('\n');

  return {
    ok: true,
    appVersion: detectedVersion,
    totalExtracted: rawSet.size,
    pendingCount: pending.length,
    pending,
    pendingFilePath,
    promptText,
    scannedSources,
  };
}
