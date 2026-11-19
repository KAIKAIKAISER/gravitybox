const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gravitybox', {
  rpc: (command, payload = {}) => ipcRenderer.invoke('gb:rpc', command, payload),
  getState: () => ipcRenderer.invoke('gb:get-state'),
  setConfig: (patch) => ipcRenderer.invoke('gb:config-set', patch),
  openAntigravity: () => ipcRenderer.invoke('gb:open-antigravity'),
  safeRelaunchAntigravity: () => ipcRenderer.invoke('gb:safe-relaunch-antigravity'),
  closeAntigravityGracefully: () => ipcRenderer.invoke('gb:close-antigravity'),
  setLoginItem: (enabled) => ipcRenderer.invoke('gb:login-item-set', enabled),
  openMainWindow: (tab) => ipcRenderer.invoke('gb:open-main', tab),
  hidePopover: () => ipcRenderer.invoke('gb:hide-popover'),
  openPath: (targetPath) => ipcRenderer.invoke('gb:open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('gb:open-external', url),
  copyText: (text) => ipcRenderer.invoke('gb:copy-text', text),
  saveJsonDialog: (defaultName, data) => ipcRenderer.invoke('gb:save-json', defaultName, data),
  checkUpdates: () => ipcRenderer.invoke('gb:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('gb:update-download'),
  cancelUpdate: () => ipcRenderer.invoke('gb:update-cancel'),
  installUpdate: () => ipcRenderer.invoke('gb:update-install'),
  quitApp: () => ipcRenderer.invoke('gb:quit'),
  onStatus: (cb) => subscribe('gb:status', cb),
  onConfig: (cb) => subscribe('gb:config', cb),
  onUpdate: (cb) => subscribe('gb:update', cb),
  onNavigate: (cb) => subscribe('gb:navigate', cb),
  onToast: (cb) => subscribe('gb:toast', cb),
});
