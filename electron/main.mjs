import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  clipboard,
  dialog,
  screen,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const RESOURCE_ROOT = app.isPackaged
  ? (existsSync(join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'main.js'))
      ? join(process.resourcesPath, 'app.asar.unpacked')
      : APP_ROOT)
  : APP_ROOT;

app.setName('GravityBox');
if (process.platform === 'win32') {
  app.setAppUserModelId('local.gravitybox.app');
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
  process.exit(0);
}

const stateDir = app.getPath('userData');
const ipcEndpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\gravitybox-${createHash('sha256').update(resolve(stateDir).toLowerCase()).digest('hex').slice(0, 20)}`
  : join(stateDir, 'control.sock');

const DEFAULT_CONFIG = {
  schema: 2,
  applicationChannel: 'stable',
  hudEnabled: true,
  appLanguage: 'system',
  quotaRefreshMinutes: 0,
  autoPricingSyncEnabled: false,
  syncAntigravityLifecycle: false,
  autoUpdateEnabled: true,
  menuSelectedTab: 0,
  menuUsagePeriod: 0,
  menuTrendMetric: 'tokens',
};

let config = { ...DEFAULT_CONFIG };
let mainWindow = null;
let popoverWindow = null;
let tray = null;
let backendChild = null;
let backendRestartAttempts = 0;
let isQuitting = false;
let latestStatus = null;
let lastPopoverBlurAt = 0;
let quotaRefreshTimer = null;
let antigravityWasObservedRunning = false;
let updateState = {
  state: 'idle', // idle | checking | up-to-date | available | downloading | ready | error
  currentVersion: app.getVersion(),
  latestTag: null,
  publishedAt: null,
  releaseUrl: null,
  notes: '',
  assetName: null,
  assetUrl: null,
  sha256Url: null,
  downloadedPath: null,
  progress: 0,
  error: null,
};
let activeDownloadAbort = null;

function readPackageMeta() {
  try {
    return JSON.parse(readFileSync(join(RESOURCE_ROOT, 'package.json'), 'utf8'));
  } catch {
    return { version: app.getVersion(), repository: { url: 'https://github.com/Enzoo404/gravitybox.git' } };
  }
}

function getRepoSlug() {
  const pkg = readPackageMeta();
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || '';
  const m = raw.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  return m ? m[1] : 'Enzoo404/gravitybox';
}

function loadI18nPacks() {
  const packs = {};
  const dir = join(RESOURCE_ROOT, 'assets', 'i18n');
  for (const code of ['zh-Hans', 'en']) {
    try {
      packs[code] = JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8'));
    } catch {}
  }
  return packs;
}

const i18nPacks = loadI18nPacks();

function resolveActiveLocale() {
  const lang = config.appLanguage || 'system';
  if (lang === 'zh-Hans' || lang === 'en') return lang;
  const sys = (app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
  return sys.startsWith('zh') ? 'zh-Hans' : 'en';
}

function t(key, params) {
  const locale = resolveActiveLocale();
  const pack = i18nPacks[locale] || i18nPacks['zh-Hans'] || i18nPacks.en;
  let tpl = pack?.app?.[key] ?? i18nPacks.en?.app?.[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      tpl = tpl.replaceAll(`{${k}}`, String(v ?? ''));
    }
  }
  return tpl;
}

function loadConfig() {
  const cfgPath = join(stateDir, 'config.json');
  try {
    mkdirSync(stateDir, { recursive: true });
    if (existsSync(cfgPath)) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = { ...DEFAULT_CONFIG, ...parsed, schema: 2, applicationChannel: 'stable' };
        return;
      }
    }
  } catch {}
  config = { ...DEFAULT_CONFIG };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch {}
}

function saveConfig(patch) {
  config = { ...config, ...patch, schema: 2, applicationChannel: 'stable' };
  const cfgPath = join(stateDir, 'config.json');
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch {}
  broadcast('gb:config', config);
  scheduleQuotaRefreshTimer();
  updateTrayMenu();
  return config;
}

function broadcast(channel, payload) {
  for (const win of [mainWindow, popoverWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function rpc(command, payload = {}, timeoutMs = 15000) {
  return new Promise((resolveReply, reject) => {
    const client = createConnection(ipcEndpoint);
    let buffer = '';
    let received = 0;
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('IPC timeout'));
    }, ['status', 'ping', 'task_list'].includes(command) ? Math.min(timeoutMs, 8000) : Math.max(timeoutMs, 120000));
    client.on('connect', () => {
      client.write(JSON.stringify({ command, ...payload }) + '\n');
    });
    client.on('data', chunk => {
      received += chunk.length;
      if (received > 4_000_000) {
        clearTimeout(timer);
        client.destroy();
        reject(new Error('Response too large'));
        return;
      }
      buffer += decoder.write(chunk);
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          resolveReply(JSON.parse(buffer.split('\n')[0]));
        } catch {
          reject(new Error('Invalid IPC response'));
        }
      }
    });
    client.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function isBackendAlive() {
  try {
    const res = await rpc('ping', {}, 1500);
    return res?.ok === true;
  } catch {
    return false;
  }
}

function spawnBackend() {
  if (isQuitting || backendChild) return;
  const entry = join(RESOURCE_ROOT, 'dist', 'main.js');
  if (!existsSync(entry)) return;

  const args = [entry, '--state-dir', stateDir];
  if (config.appLanguage) {
    args.push('--locale', config.appLanguage);
  }
  const sysLocale = app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale;
  if (sysLocale) {
    args.push('--system-locales', sysLocale);
  }

  backendChild = spawn(process.execPath, args, {
    cwd: RESOURCE_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      GRAVITYBOX_NODE_BINARY: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  backendChild.stderr?.on('data', chunk => {
    const msg = String(chunk).trim();
    if (msg && !msg.includes('ExperimentalWarning')) {
      console.error('[Backend]', msg);
    }
  });

  backendChild.once('exit', () => {
    backendChild = null;
    if (!isQuitting && backendRestartAttempts < 5) {
      backendRestartAttempts++;
      setTimeout(() => {
        if (!isQuitting) spawnBackend();
      }, 1500 * backendRestartAttempts);
    }
  });
}

async function ensureBackendRunning() {
  if (await isBackendAlive()) {
    backendRestartAttempts = 0;
    return;
  }
  spawnBackend();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await isBackendAlive()) {
      backendRestartAttempts = 0;
      return;
    }
  }
}

async function stopBackendGracefully() {
  try {
    await rpc('stop', {}, 2500);
  } catch {}
  if (backendChild && backendChild.exitCode === null && backendChild.signalCode === null) {
    await new Promise(r => setTimeout(r, 400));
    try {
      backendChild.kill();
    } catch {}
  }
}

function findWindowsAntigravityExe() {
  const candidates = [
    join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe'),
    join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Antigravity', 'Antigravity.exe'),
  ];
  return candidates.find(p => existsSync(p)) || null;
}

async function isAntigravityProcessRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'],
      { timeout: 3000, windowsHide: true }
    );
    return /Antigravity\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

async function closeAntigravityGracefully(timeoutMs = 12000) {
  if (process.platform !== 'win32') return false;
  if (!(await isAntigravityProcessRunning())) return true;
  try {
    await execFileAsync('taskkill.exe', ['/IM', 'Antigravity.exe'], {
      timeout: 4000,
      windowsHide: true,
    });
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAntigravityProcessRunning())) {
      await new Promise(r => setTimeout(r, 350));
      return true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return !(await isAntigravityProcessRunning());
}

async function launchAntigravityWithDebugPort() {
  const exe = findWindowsAntigravityExe();
  if (!exe) {
    throw new Error('Antigravity.exe not found');
  }
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { ok: true, exe };
}

async function openOrActivateAntigravity() {
  if (await isAntigravityProcessRunning()) {
    // Focus existing Antigravity window if possible
    try {
      const ps = `
        $p = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($p) {
          Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);' -Name Win32Focus -Namespace GB
          [GB.Win32Focus]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
          [GB.Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        }
      `;
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        timeout: 3000,
        windowsHide: true,
      });
    } catch {}
    return { ok: true, alreadyRunning: true };
  }
  return launchAntigravityWithDebugPort();
}

async function safeRelaunchAntigravity() {
  const closed = await closeAntigravityGracefully(10000);
  if (!closed) {
    return { ok: false, error: t('assistant.safe_relaunch_timeout') };
  }
  return launchAntigravityWithDebugPort();
}

function getTrayIcon() {
  const trayPath = join(RESOURCE_ROOT, 'assets', 'icons', 'tray.png');
  const fallback = join(RESOURCE_ROOT, 'assets', 'icons', 'app.ico');
  const target = existsSync(trayPath) ? trayPath : fallback;
  const img = nativeImage.createFromPath(target);
  return process.platform === 'win32' ? img.resize({ width: 16, height: 16 }) : img;
}

function getWindowIcon() {
  const icoPath = join(RESOURCE_ROOT, 'assets', 'icons', 'app.ico');
  const pngPath = join(RESOURCE_ROOT, 'assets', 'master-1024.png');
  return existsSync(icoPath) ? icoPath : pngPath;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const isDark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'GravityBox',
    icon: getWindowIcon(),
    backgroundColor: isDark ? '#14161b' : '#f5f6f8',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? {
          color: isDark ? '#14161b' : '#f5f6f8',
          symbolColor: isDark ? '#e5e7eb' : '#111827',
          height: 36,
        }
      : false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  return mainWindow;
}

function createPopoverWindow() {
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;
  const isDark = nativeTheme.shouldUseDarkColors;
  popoverWindow = new BrowserWindow({
    width: 424,
    height: 556,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: isDark ? '#181a20' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  popoverWindow.loadFile(join(__dirname, 'renderer', 'popover.html'));
  popoverWindow.on('blur', () => {
    lastPopoverBlurAt = Date.now();
    if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
      popoverWindow.hide();
    }
  });
  return popoverWindow;
}

function positionAndShowPopover() {
  const win = createPopoverWindow();
  const bounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const point = bounds.width > 0 ? { x: bounds.x, y: bounds.y } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  const winW = 424;
  const winH = 556;
  let x = bounds.width > 0 ? Math.round(bounds.x + bounds.width / 2 - winW / 2) : wa.x + wa.width - winW - 12;
  x = Math.max(wa.x + 8, Math.min(wa.x + wa.width - winW - 8, x));
  const y = wa.y + wa.height - winH - 10;
  win.setPosition(x, y, false);
  win.show();
  win.focus();
}

function togglePopover() {
  const win = createPopoverWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  if (Date.now() - lastPopoverBlurAt < 180) {
    return;
  }
  positionAndShowPopover();
}

function showMainWindow(tab) {
  const win = createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (tab) {
    win.webContents.send('gb:navigate', tab);
  }
}

function updateTrayTooltip() {
  if (!tray) return;
  const s = latestStatus?.status;
  if (!s) {
    tray.setToolTip('GravityBox');
    return;
  }
  const email = s.activeAccountEmail ? ` · ${s.activeAccountEmail}` : '';
  const quota = typeof s.activeFiveHourQuota === 'number' ? ` · 5h ${s.activeFiveHourQuota}%` : '';
  tray.setToolTip(`GravityBox · ${s.message || s.mode || ''}${email}${quota}`);
}

function updateTrayMenu() {
  if (!tray) return;
  const lang = config.appLanguage || 'system';
  const menu = Menu.buildFromTemplate([
    { label: t('menu_panel.footer.open_main').replace(' ↗', ''), click: () => showMainWindow('overview') },
    { label: t('nav.accounts'), click: () => showMainWindow('accounts') },
    { label: t('nav.usage'), click: () => showMainWindow('usage') },
    { type: 'separator' },
    { label: t('sidebar.open_antigravity'), click: () => { void openOrActivateAntigravity(); } },
    {
      label: t('menu.language'),
      submenu: [
        {
          label: t('language.system'),
          type: 'radio',
          checked: lang === 'system',
          click: () => { void applyLanguage('system'); },
        },
        {
          label: '简体中文',
          type: 'radio',
          checked: lang === 'zh-Hans',
          click: () => { void applyLanguage('zh-Hans'); },
        },
        {
          label: 'English',
          type: 'radio',
          checked: lang === 'en',
          click: () => { void applyLanguage('en'); },
        },
      ],
    },
    { label: t('menu.check_updates'), click: () => { showMainWindow('about'); void checkForUpdates(); } },
    { type: 'separator' },
    { label: t('menu.settings'), click: () => showMainWindow('settings') },
    { label: t('menu.quit'), click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

async function applyLanguage(language) {
  saveConfig({ appLanguage: language });
  try {
    await rpc('language_set', {
      language,
      systemLocales: [app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale].filter(Boolean),
    });
    await pollStatusOnce();
  } catch {}
}

function scheduleQuotaRefreshTimer() {
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = null;
  }
  const mins = Number(config.quotaRefreshMinutes) || 0;
  if (mins > 0) {
    quotaRefreshTimer = setInterval(() => {
      void rpc('quota_refresh_start').catch(() => {});
    }, mins * 60_000);
  }
}

async function pollStatusOnce() {
  try {
    const res = await rpc('status', { includeTasks: true }, 6000);
    if (res?.ok) {
      latestStatus = res;
      updateTrayTooltip();
      broadcast('gb:status', res);
      if (config.syncAntigravityLifecycle) {
        const running = await isAntigravityProcessRunning();
        if (running) {
          antigravityWasObservedRunning = true;
        } else if (antigravityWasObservedRunning) {
          isQuitting = true;
          app.quit();
        }
      }
    }
  } catch {
    if (!backendChild && !isQuitting) {
      void ensureBackendRunning();
    }
  }
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  broadcast('gb:update', updateState);
}

async function checkForUpdates() {
  const repo = getRepoSlug();
  publishUpdateState({ state: 'checking', error: null });
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `GravityBox/${app.getVersion()}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      publishUpdateState({ state: 'up-to-date', latestTag: `v${app.getVersion()}`, error: null });
      return updateState;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const release = await res.json();
    const tag = String(release.tag_name || '').trim();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exeAsset = assets.find(a => /GravityBox-Setup-.*\.exe$/i.test(a.name)) ||
      assets.find(a => /\.exe$/i.test(a.name)) ||
      assets.find(a => /\.zip$/i.test(a.name));
    const shaAsset = exeAsset ? assets.find(a => a.name === `${exeAsset.name}.sha256`) : null;

    if (!tag || compareSemver(tag, app.getVersion()) <= 0) {
      publishUpdateState({
        state: 'up-to-date',
        latestTag: tag || `v${app.getVersion()}`,
        publishedAt: release.published_at || null,
        releaseUrl: release.html_url || `https://github.com/${repo}/releases`,
        notes: release.body || '',
        assetName: exeAsset?.name || null,
        assetUrl: exeAsset?.browser_download_url || null,
        sha256Url: shaAsset?.browser_download_url || null,
      });
      return updateState;
    }

    publishUpdateState({
      state: 'available',
      latestTag: tag,
      publishedAt: release.published_at || null,
      releaseUrl: release.html_url || `https://github.com/${repo}/releases`,
      notes: release.body || '',
      assetName: exeAsset?.name || null,
      assetUrl: exeAsset?.browser_download_url || null,
      sha256Url: shaAsset?.browser_download_url || null,
      downloadedPath: null,
      progress: 0,
    });
    return updateState;
  } catch (err) {
    publishUpdateState({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    return updateState;
  }
}

async function downloadAvailableUpdate() {
  if (!updateState.assetUrl || !updateState.assetName) {
    if (updateState.releaseUrl) await shell.openExternal(updateState.releaseUrl);
    return updateState;
  }
  const updatesDir = join(stateDir, 'updates');
  await mkdir(updatesDir, { recursive: true });
  const targetPath = join(updatesDir, updateState.assetName);
  activeDownloadAbort = new AbortController();
  publishUpdateState({ state: 'downloading', progress: 0, error: null });
  try {
    let expectedSha = null;
    if (updateState.sha256Url) {
      const shaRes = await fetch(updateState.sha256Url, { signal: activeDownloadAbort.signal });
      if (shaRes.ok) {
        const text = await shaRes.text();
        const m = text.match(/^([0-9a-fA-F]{64})\b/m);
        if (m) expectedSha = m[1].toLowerCase();
      }
    }
    const res = await fetch(updateState.assetUrl, { signal: activeDownloadAbort.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const hash = createHash('sha256');
    const out = createWriteStream(targetPath);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      hash.update(value);
      out.write(value);
      if (total > 0) {
        publishUpdateState({ progress: Math.min(99, Math.round((received / total) * 100)) });
      }
    }
    await new Promise((resClose, rejClose) => {
      out.end(() => resClose());
      out.on('error', rejClose);
    });
    const actualSha = hash.digest('hex').toLowerCase();
    if (expectedSha && actualSha !== expectedSha) {
      await rm(targetPath, { force: true }).catch(() => {});
      throw new Error('SHA-256 checksum mismatch');
    }
    publishUpdateState({ state: 'ready', progress: 100, downloadedPath: targetPath });
    return updateState;
  } catch (err) {
    if (err?.name === 'AbortError') {
      publishUpdateState({ state: 'available', progress: 0, error: null });
    } else {
      publishUpdateState({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    return updateState;
  } finally {
    activeDownloadAbort = null;
  }
}

function setupIpcHandlers() {
  ipcMain.handle('gb:rpc', async (_event, command, payload = {}) => {
    try {
      if (command === 'language_set' && payload?.language) {
        saveConfig({ appLanguage: payload.language });
      } else if (command === 'hud_set') {
        saveConfig({ hudEnabled: payload?.enabled !== false });
      } else if (command === 'pricing_sync_set') {
        saveConfig({ autoPricingSyncEnabled: payload?.enabled === true });
      }
      return await rpc(command, payload);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gb:get-state', async () => {
    const pkg = readPackageMeta();
    const loginSettings = app.getLoginItemSettings();
    const antigravityExe = findWindowsAntigravityExe();
    return {
      status: latestStatus,
      config,
      i18nPacks,
      activeLocale: resolveActiveLocale(),
      systemLocale: app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale || 'en',
      updateState,
      appInfo: {
        version: pkg.version || app.getVersion(),
        repoSlug: getRepoSlug(),
        stateDir,
        antigravityExe,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        openAtLogin: loginSettings.openAtLogin,
      },
    };
  });

  ipcMain.handle('gb:config-set', async (_event, patch) => {
    return saveConfig(patch || {});
  });

  ipcMain.handle('gb:open-antigravity', async () => {
    try {
      return await openOrActivateAntigravity();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gb:safe-relaunch-antigravity', async () => {
    try {
      return await safeRelaunchAntigravity();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gb:close-antigravity', async () => {
    const ok = await closeAntigravityGracefully(12000);
    return { ok };
  });

  ipcMain.handle('gb:login-item-set', async (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
  });

  ipcMain.handle('gb:open-main', async (_event, tab) => {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    showMainWindow(tab);
    return { ok: true };
  });

  ipcMain.handle('gb:hide-popover', async () => {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    return { ok: true };
  });

  ipcMain.handle('gb:open-path', async (_event, targetPath) => {
    if (typeof targetPath === 'string' && targetPath) {
      await shell.openPath(targetPath);
    }
    return { ok: true };
  });

  ipcMain.handle('gb:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  ipcMain.handle('gb:copy-text', async (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  ipcMain.handle('gb:save-json', async (_event, defaultName, data) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'gravitybox-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await writeFile(res.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, filePath: res.filePath };
  });

  ipcMain.handle('gb:update-check', () => checkForUpdates());
  ipcMain.handle('gb:update-download', () => downloadAvailableUpdate());
  ipcMain.handle('gb:update-cancel', () => {
    activeDownloadAbort?.abort();
    return { ok: true };
  });
  ipcMain.handle('gb:update-install', async () => {
    if (updateState.downloadedPath && existsSync(updateState.downloadedPath)) {
      await shell.openPath(updateState.downloadedPath);
      return { ok: true };
    }
    if (updateState.releaseUrl) {
      await shell.openExternal(updateState.releaseUrl);
    }
    return { ok: false };
  });
  ipcMain.handle('gb:quit', () => {
    isQuitting = true;
    app.quit();
    return { ok: true };
  });
}

app.on('second-instance', () => {
  showMainWindow('overview');
});

app.on('window-all-closed', e => {
  // Keep resident in Windows system tray unless user explicitly quits
  if (!isQuitting) {
    e.preventDefault?.();
  }
});

app.on('before-quit', async event => {
  if (isQuitting && backendChild) {
    event.preventDefault();
    await stopBackendGracefully();
    app.exit(0);
  }
});

nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
    const isDark = nativeTheme.shouldUseDarkColors;
    mainWindow.setTitleBarOverlay({
      color: isDark ? '#14161b' : '#f5f6f8',
      symbolColor: isDark ? '#e5e7eb' : '#111827',
    });
  }
});

app.whenReady().then(async () => {
  loadConfig();
  setupIpcHandlers();

  tray = new Tray(getTrayIcon());
  tray.setToolTip('GravityBox');
  tray.on('click', () => togglePopover());
  updateTrayMenu();

  createMainWindow();
  createPopoverWindow();
  // Show main window on launch unless started hidden (--tray)
  if (!process.argv.includes('--tray')) {
    showMainWindow('overview');
  }

  await ensureBackendRunning();
  await pollStatusOnce();
  setInterval(() => {
    void pollStatusOnce();
  }, 3000);
  scheduleQuotaRefreshTimer();

  if (config.autoUpdateEnabled) {
    setTimeout(() => {
      void checkForUpdates();
    }, 8000);
  }
});
