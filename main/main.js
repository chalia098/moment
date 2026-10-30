// Moment のメインプロセス：ウインドウ、メニュー、保存、書き出しの窓口。
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store, fingerprint } = require('./store');
const { LogError } = require('./worklog');
const media = require('./media');

if (process.env.MOMENT_USER_DATA) app.setPath('userData', process.env.MOMENT_USER_DATA);
app.setName('Moment');

const ROOT = path.join(__dirname, '..');
const isMac = process.platform === 'darwin';
let store;
let settings;
let mainWin = null;
let keyWin = null;
let keyData = null;
let job = null;
let jobDone = Promise.resolve(); // 動いている処理が後片付けまで終わったら解決する
let flushed = false;
let quitReady = false;

// ---------- ウインドウ ----------
function createMainWindow() {
  const saved = store.loadWindowState();
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = saved && saved.width ? saved : {
    width: Math.min(1440, Math.round(area.width * 0.9)),
    height: Math.min(960, Math.round(area.height * 0.92))
  };
  mainWin = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 620,
    title: 'Moment',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181a' : '#f6f6f7',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  if (saved && saved.maximized) mainWin.maximize();
  mainWin.loadFile(path.join(ROOT, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());

  const remember = () => {
    if (!mainWin || mainWin.isDestroyed() || mainWin.isFullScreen()) return;
    store.saveWindowStateSync({ ...mainWin.getNormalBounds(), maximized: mainWin.isMaximized() });
  };
  mainWin.on('resize', debounce(remember, 400));
  mainWin.on('move', debounce(remember, 400));
  mainWin.on('close', e => {
    remember();
    if (flushed) return;
    e.preventDefault();
    send('app:flush');
    setTimeout(() => { flushed = true; if (mainWin && !mainWin.isDestroyed()) mainWin.close(); }, 1500);
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (keyWin && !keyWin.isDestroyed()) keyWin.destroy();
  });
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', e => e.preventDefault());
}

function createKeyWindow() {
  if (keyWin && !keyWin.isDestroyed()) return keyWin;
  const display = mainWin ? screen.getDisplayMatching(mainWin.getBounds()) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  keyWin = new BrowserWindow({
    width: 260,
    height: 420,
    x: wa.x + wa.width - 260 - 24,
    y: wa.y + 64,
    title: 'キー表示',
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...(isMac ? { type: 'panel' } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f22' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  keyWin.setAlwaysOnTop(true, 'floating');
  try { keyWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 対応していない環境 */ }
  keyWin.loadFile(path.join(ROOT, 'src', 'keys.html'));
  keyWin.webContents.on('did-finish-load', () => { if (keyData) keyWin.webContents.send('keys:data', keyData); });
  // キー表示に入力を取られないよう、触られたら作業画面へ戻す
  keyWin.on('focus', () => setTimeout(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.focus(); }, 0));
  keyWin.on('close', e => {
    if (mainWin && !mainWin.isDestroyed()) { e.preventDefault(); keyWin.hide(); send('keys:visible', false); }
  });
  return keyWin;
}

function toggleKeyWindow(force) {
  const win = createKeyWindow();
  const show = typeof force === 'boolean' ? force : !win.isVisible();
  if (show) { win.showInactive(); } else { win.hide(); }
  send('keys:visible', show);
  return show;
}

function send(channel, ...args) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, ...args);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- メニュー ----------
function accelerator(combo) {
  if (!combo || !combo.meta) return undefined;
  const c = combo.code || '';
  let key = null;
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) key = m[1];
  else if ((m = /^Digit(\d)$/.exec(c))) key = m[1];
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else key = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }[c];
  if (!key) return undefined;
  return ['CmdOrCtrl', combo.shift ? 'Shift' : null, combo.alt ? 'Alt' : null, key].filter(Boolean).join('+');
}

function buildMenu() {
  const toMain = ch => () => send(ch);
  const template = [
    ...(isMac ? [{
      label: 'Moment',
      submenu: [
        { role: 'about', label: 'Moment について' },
        { type: 'separator' },
        { label: '設定…', accelerator: 'CmdOrCtrl+,', click: toMain('menu:settings') },
        { type: 'separator' },
        { role: 'hide', label: 'Moment を隠す' },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: 'Moment を終了' }
      ]
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '新しく始める…', accelerator: 'CmdOrCtrl+N', click: toMain('menu:new') },
        { label: '動画を結合…', click: toMain('menu:merge') },
        { label: '作業ログに戻る', accelerator: 'CmdOrCtrl+L', click: toMain('menu:log') },
        { type: 'separator' },
        { label: 'ダウンロード…', accelerator: 'CmdOrCtrl+D', click: toMain('menu:export') },
        { type: 'separator' },
        { label: '作業ログを読み込む…', click: toMain('menu:import') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: '設定…', accelerator: 'CmdOrCtrl+,', click: toMain('menu:settings') }, { role: 'quit', label: '終了' }])
      ]
    },
    {
      label: '編集',
      submenu: [
        { label: '元に戻す', accelerator: 'CmdOrCtrl+Z', click: toMain('menu:undo') },
        { label: 'やり直す', accelerator: 'Shift+CmdOrCtrl+Z', click: toMain('menu:redo') },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべてを選択' }
      ]
    },
    {
      label: '表示',
      submenu: [
        { label: 'キー表示', accelerator: accelerator(settings.baseKeys.toggleKeys), click: () => toggleKeyWindow() },
        { role: 'togglefullscreen', label: '全画面' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools', label: '開発者ツール' }, { role: 'reload', label: '再読み込み' }])
      ]
    },
    { role: 'windowMenu', label: 'ウインドウ' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyTheme() {
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
}

// ---------- 窓口（IPC） ----------
function videoFilters() {
  return [{ name: '動画', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'mts', 'm2ts', 'webm', 'MP4', 'MOV', 'M4V', 'MTS'] }];
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));
  ipcMain.on('app:flushed', () => { flushed = true; if (mainWin && !mainWin.isDestroyed()) mainWin.close(); });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, next) => {
    settings = next;
    await store.saveSettings(settings);
    applyTheme();
    buildMenu();
    return true;
  });

  ipcMain.handle('logs:list', () => store.listLogs());
  ipcMain.handle('logs:get', (_e, id) => store.getLog(id));
  ipcMain.handle('logs:save', async (_e, log) => {
    try { return { ok: true, updatedAt: await store.saveLog(log) }; } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('logs:delete', async (_e, id, name) => {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'warning', buttons: ['削除する', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: `「${name || '作業ログ'}」を削除しますか？`, detail: 'この試合のタグがすべて消えます。動画ファイルは消えません。\nプレイリストに入れたこの試合のシーンも、再生できなくなります。'
    });
    if (r.response !== 0) return false;
    await store.deleteLog(id);
    return true;
  });
  ipcMain.handle('logs:export', async (_e, id) => {
    const log = await store.getLog(id);
    if (!log) return { ok: false };
    const r = await dialog.showSaveDialog(mainWin, {
      title: '作業ログをファイルに保存',
      defaultPath: `${(log.gameName || 'Moment').replace(/[\\/:*?"<>|]/g, '-')}.moment.json`,
      filters: [{ name: 'Moment 作業ログ', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const data = { kind: 'moment-worklog', exportedAt: new Date().toISOString(), log, shortcuts: settings.shortcuts.concat(settings.deletedShortcuts || []) };
    await fs.promises.writeFile(r.filePath, JSON.stringify(data, null, 2));
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('logs:import', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '作業ログを読み込む', properties: ['openFile'], filters: [{ name: 'Moment 作業ログ', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    // 中身を確かめ、確かめた項目だけで作り直す。正しくなければ何も書き換えない
    let imported;
    try {
      imported = await store.readImport(r.filePaths[0]);
    } catch (err) {
      return { ok: false, reason: `作業ログを読み込めません（${err instanceof LogError ? err.message : 'ファイルを開けません'}）` };
    }
    const { log, exists } = imported;
    if (exists) {
      const q = await dialog.showMessageBox(mainWin, { type: 'question', buttons: ['上書きする', 'キャンセル'], defaultId: 1, cancelId: 1, message: '同じ作業ログがあります。上書きしますか？' });
      if (q.response !== 0) return { ok: false };
    }
    try {
      await store.saveLog(log);
      return { ok: true, id: log.id };
    } catch {
      return { ok: false, reason: '作業ログを保存できませんでした' };
    }
  });

  ipcMain.handle('playlists:list', () => store.listPlaylists());
  ipcMain.handle('playlists:get', (_e, id) => store.getPlaylist(id));
  ipcMain.handle('playlists:save', async (_e, pl) => {
    try { return { ok: true, updatedAt: await store.savePlaylist(pl) }; } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('playlists:delete', async (_e, id, name) => {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'warning', buttons: ['削除する', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: `「${name || 'プレイリスト'}」を削除しますか？`, detail: 'プレイリストだけが消えます。中のシーン（作業ログ）と動画ファイルは消えません。'
    });
    if (r.response !== 0) return false;
    await store.deletePlaylist(id);
    return true;
  });

  ipcMain.handle('video:choose', async (_e, message) => {
    const r = await dialog.showOpenDialog(mainWin, { title: '動画を選ぶ', message: message || undefined, properties: ['openFile'], filters: videoFilters() });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  ipcMain.handle('video:chooseMany', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '結合する動画を選ぶ', properties: ['openFile', 'multiSelections'], filters: videoFilters() });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('video:inspect', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: '動画ファイルを開けません' };
      const fp = await fingerprint(filePath);
      return { ok: true, path: filePath, fileName: path.basename(filePath), size: fp.size, fingerprint: fp.fingerprint, url: pathToFileURL(filePath).href };
    } catch (err) {
      return { ok: false, reason: '動画ファイルを開けません' };
    }
  });
  ipcMain.handle('video:confirmSwap', async (_e, fileName) => {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'question', buttons: ['再開する', 'キャンセル'], defaultId: 0, cancelId: 1,
      message: '前回の動画と中身が少し違います。この動画で再開しますか？', detail: `${fileName || ''}\n長さは前回の動画と同じです。`
    });
    return r.response === 0;
  });
  ipcMain.handle('video:exists', (_e, p) => !!p && fs.existsSync(p));
  ipcMain.handle('video:findLog', (_e, fp) => store.findLogByFingerprint(fp));
  // 裏で調べる（待っている間も画面とほかの窓口は動く）
  ipcMain.handle('video:probe', async (_e, p) => {
    try { return await media.probe(p); } catch (err) { return { ok: false, error: 'spawn', reason: err.message }; }
  });

  ipcMain.handle('dialog:chooseFolder', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWin, { title: '保存先を選ぶ', defaultPath: defaultPath || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  ipcMain.handle('dialog:saveVideo', async (_e, defaultName) => {
    const r = await dialog.showSaveDialog(mainWin, { title: '結合した動画の保存先', defaultPath: defaultName, properties: ['createDirectory', 'showOverwriteConfirmation'] });
    return r.canceled ? null : r.filePath || null;
  });

  ipcMain.handle('export:start', (e, opts) => runJob(e, (j, emit) => media.exportScenes(j, opts, emit).then(summary => ({ ok: true, ...summary }))));
  ipcMain.handle('export:playlist', (e, opts) => runJob(e, (j, emit) => media.exportPlaylist(j, opts, emit).then(summary => ({ ok: true, ...summary }))));
  ipcMain.handle('merge:start', (e, opts) => runJob(e, (j, emit) => media.mergeVideos(j, opts, emit)));
  ipcMain.handle('job:cancel', () => { if (job) job.cancel(); return true; });
  ipcMain.handle('shell:openFolder', (_e, dir) => shell.openPath(dir));

  ipcMain.handle('keys:toggle', (_e, force) => toggleKeyWindow(force));
  ipcMain.on('keys:update', (_e, data) => {
    keyData = data;
    if (keyWin && !keyWin.isDestroyed()) keyWin.webContents.send('keys:data', data);
  });
  ipcMain.on('keys:resize', (_e, h) => {
    if (keyWin && !keyWin.isDestroyed()) {
      const [w] = keyWin.getContentSize();
      keyWin.setContentSize(w, Math.max(160, Math.min(900, Math.round(h))));
    }
  });
}

// ダウンロードと結合は1つずつ。終わる（後片付けまで済む）のを jobDone で待てるようにする
async function runJob(e, work) {
  if (job) return { ok: false, reason: 'ほかの処理が動いています' };
  job = new media.Job();
  const emit = ev => { if (!e.sender.isDestroyed()) e.sender.send('job:event', ev); };
  const p = work(job, emit);
  jobDone = p.catch(() => {});
  try {
    return await p;
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally { job = null; }
}

// ---------- 起動 ----------
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  settings = store.loadSettings();
  applyTheme();
  if (isMac && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'))); } catch { /* アイコンなしで続ける */ }
  }
  registerIpc();
  buildMenu();
  createMainWindow();
  app.on('activate', () => { if (!mainWin) { flushed = false; createMainWindow(); } });
});

app.on('window-all-closed', () => app.quit());

// 終了する前に、動いている ffmpeg を止めて後片付けを待ち、受け付けた保存が全部終わるのを待つ
app.on('will-quit', e => {
  if (quitReady || !store) return;
  e.preventDefault();
  if (job) job.cancel();
  Promise.all([jobDone, store.idle()]).finally(() => { quitReady = true; app.quit(); });
});
