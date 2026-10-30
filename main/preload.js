// 画面（renderer）に渡す窓口。Node の機能は直接渡さない。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('moment', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  flushed: () => ipcRenderer.send('app:flushed'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: s => ipcRenderer.invoke('settings:set', s),

  listLogs: () => ipcRenderer.invoke('logs:list'),
  getLog: id => ipcRenderer.invoke('logs:get', id),
  saveLog: log => ipcRenderer.invoke('logs:save', log),
  deleteLog: (id, name) => ipcRenderer.invoke('logs:delete', id, name),
  exportLog: id => ipcRenderer.invoke('logs:export', id),
  importLog: () => ipcRenderer.invoke('logs:import'),

  listPlaylists: () => ipcRenderer.invoke('playlists:list'),
  getPlaylist: id => ipcRenderer.invoke('playlists:get', id),
  savePlaylist: pl => ipcRenderer.invoke('playlists:save', pl),
  deletePlaylist: (id, name) => ipcRenderer.invoke('playlists:delete', id, name),

  chooseVideo: message => ipcRenderer.invoke('video:choose', message),
  chooseVideos: () => ipcRenderer.invoke('video:chooseMany'),
  inspectVideo: p => ipcRenderer.invoke('video:inspect', p),
  videoExists: p => ipcRenderer.invoke('video:exists', p),
  findLogByFingerprint: fp => ipcRenderer.invoke('video:findLog', fp),
  probeVideo: p => ipcRenderer.invoke('video:probe', p),
  confirmVideoSwap: fileName => ipcRenderer.invoke('video:confirmSwap', fileName),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return null; } },

  chooseFolder: defaultPath => ipcRenderer.invoke('dialog:chooseFolder', defaultPath),
  saveVideoAs: defaultName => ipcRenderer.invoke('dialog:saveVideo', defaultName),

  startExport: opts => ipcRenderer.invoke('export:start', opts),
  startPlaylistExport: opts => ipcRenderer.invoke('export:playlist', opts),
  startMerge: opts => ipcRenderer.invoke('merge:start', opts),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  openFolder: dir => ipcRenderer.invoke('shell:openFolder', dir),

  toggleKeys: force => ipcRenderer.invoke('keys:toggle', force),
  updateKeys: data => ipcRenderer.send('keys:update', data),
  resizeKeys: h => ipcRenderer.send('keys:resize', h),

  on
});
