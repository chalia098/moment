// Moment の画面。起動画面（作業ログ・新しく始める・動画を結合・設定）と作業画面。
(function () {
  'use strict';
  const C = window.MomentCore;
  const api = window.moment;
  const $ = id => document.getElementById(id);
  const isWin = api.platform === 'win32';
  const FOLDER_APP = isWin ? 'エクスプローラー' : 'Finder';

  const state = {
    settings: null,
    view: 'launcher',
    pane: 'logs',
    logs: [],
    newFlow: null,
    merge: { files: [], title: '', quality: 'source', phase: 'edit', progress: 0, output: null },
    game: null,
    video: null,
    pending: null,
    selectedId: null,
    checked: new Set(),
    sort: 'timeDesc',
    filter: 'all',
    memoQuery: '',
    undo: [],
    redo: [],
    stopAt: null,
    speedIndex: C.SPEEDS.indexOf(1),
    keysVisible: false,
    editing: null,
    flashId: null,
    capture: null,
    sheet: null,
    pls: [], // 起動画面のプレイリストの一覧
    plNew: false,
    pl: null // 開いているプレイリスト（プレイリスト画面）
  };

  // ---------- 小さな道具 ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'checked' || k === 'value' || k === 'disabled' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }
  function kbd(text) { return h('span', { class: 'kbd' }, text); }
  const L = combo => C.keyLabel(combo, api.platform);
  const baseName = name => String(name || '').replace(/\.[^.]+$/, '');
  const round3 = n => Math.round(n * 1000) / 1000;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
  }
  // 長いパスは先頭を省いて、フォルダ名が見えるようにする
  function shortPath(p, max = 56) {
    if (!p) return '';
    return p.length <= max ? p : `…${p.slice(-(max - 1))}`;
  }
  function isTyping(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes((el.type || 'text').toLowerCase());
    return false;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- 設定 ----------
  const DEFAULT_LIST_RATIO = 0.32;
  const MIN_VIDEO = 140;
  const MIN_LIST = 120;
  // 映像とタグ一覧の高さ。比率（タグ一覧の割合）を覚えておき、今のウインドウの高さからピクセルに直す。
  // 映像は残り全部を使うので、どの比率でも隙間はできない。
  function listHeightFor(avail, ratio) {
    return Math.round(Math.max(MIN_LIST, Math.min(avail - MIN_VIDEO, ratio * avail)));
  }
  // 作業画面とプレイリスト画面で同じ比率を使う
  function layoutList() {
    const w = $(state.view === 'playlist' ? 'plView' : 'work');
    if (w.hidden) return;
    const avail = w.clientHeight - w.querySelector('.bar').offsetHeight;
    if (avail <= 0) return;
    w.style.setProperty('--list-h', `${listHeightFor(avail, state.settings.listRatio || DEFAULT_LIST_RATIO)}px`);
  }

  async function saveSettings() {
    await api.setSettings(state.settings);
    pushKeyData();
  }

  function keyGame() {
    if (state.game) return state.game;
    if (state.newFlow) return { teamA: state.newFlow.teamA, teamB: state.newFlow.teamB };
    return null;
  }

  function buildKeyData() {
    const s = state.settings;
    const g = keyGame();
    const b = s.baseKeys;
    return {
      sections: [
        { title: '記録', items: [{ key: L(b.start), label: '開始' }, { key: L(b.end), label: '終了' }, { key: L(b.cancel), label: '取り消し' }] },
        { title: 'ショートカット', items: s.shortcuts.map(sc => ({ key: sc.key && sc.key.code ? L(sc.key) : '—', label: sc.team ? `${C.teamName(g, sc.team)} ${sc.name}` : sc.name, team: sc.team })) },
        { title: '再生', items: [{ key: L(b.playPause), label: '再生 / 停止' }, { key: `${L(b.back)}  ${L(b.forward)}`, label: '3秒戻る / 進む' }, { key: `${L(b.slower)}  ${L(b.faster)}`, label: '速度' }] }
      ]
    };
  }
  function pushKeyData() { if (state.settings) api.updateKeys(buildKeyData()); }

  // ---------- 起動画面 ----------
  function showLauncher(pane) {
    leavePlaylist();
    state.view = 'launcher';
    $('work').hidden = true;
    $('launcher').hidden = false;
    document.title = 'Moment';
    selectPane(pane || 'logs');
  }

  function selectPane(p) {
    state.pane = p;
    for (const b of document.querySelectorAll('.rail-item')) b.setAttribute('aria-current', b.dataset.pane === p ? 'page' : 'false');
    for (const s of ['logs', 'new', 'merge', 'playlists', 'settings']) $(`pane-${s}`).hidden = s !== p;
    if (p === 'logs') refreshLogs();
    if (p === 'playlists') { state.plNew = false; refreshPlaylists(); }
    if (p === 'new') renderNew();
    if (p === 'merge') renderMerge();
    if (p === 'settings') renderSettings($('settingsContent'));
  }

  // 作業ログ
  async function refreshLogs() {
    state.logs = await api.listLogs();
    renderLogs();
  }

  function renderLogs() {
    const box = $('logList');
    box.replaceChildren();
    if (!state.logs.length) {
      box.append(h('div', { class: 'empty' },
        h('p', {}, 'まだ作業ログがありません。'),
        h('p', {}, '左の「新しく始める」から、試合の動画を選んでください。')));
      return;
    }
    for (const l of state.logs) box.append(logRow(l));
  }

  function logRow(l) {
    const row = h('div', { class: 'log-row' });
    const main = h('button', { class: 'log-main', onClick: () => resumeLog(l.id) },
      h('span', { class: 'log-name' }, l.gameName || baseName(l.videoFileName) || '名前なし'),
      h('span', { class: 'log-cell' }, `${C.teamName(l, 'A')} vs ${C.teamName(l, 'B')}`),
      h('span', { class: 'log-cell' }, `${l.sceneCount}タグ`),
      h('span', { class: 'log-cell date' }, fmtDate(l.updatedAt)));
    const actions = h('div', { class: 'log-actions' },
      h('button', { class: 'btn small', onClick: () => editLogRow(row, l) }, '編集'),
      h('button', { class: 'btn small', onClick: async () => { const r = await api.exportLog(l.id); if (r && r.ok) toast('作業ログをファイルに保存しました'); } }, 'ファイルに保存'),
      h('button', { class: 'btn small danger', onClick: async () => { if (await api.deleteLog(l.id, l.gameName)) refreshLogs(); } }, '削除'));
    row.append(main, actions);
    return row;
  }

  function editLogRow(row, l) {
    const name = h('input', { class: 'field', value: l.gameName || '', 'aria-label': '試合名' });
    const a = h('input', { class: 'field', value: l.teamA || '', placeholder: 'チームA', 'aria-label': 'チームAの名前' });
    const b = h('input', { class: 'field', value: l.teamB || '', placeholder: 'チームB', 'aria-label': 'チームBの名前' });
    const save = async () => {
      const log = await api.getLog(l.id);
      if (!log) return;
      log.gameName = name.value.trim() || log.gameName;
      log.teamA = a.value.trim();
      log.teamB = b.value.trim();
      const r = await api.saveLog(log);
      if (!r || !r.ok) toast('作業ログを保存できませんでした');
      refreshLogs();
    };
    const form = h('div', { class: 'log-edit' }, name, a, b,
      h('button', { class: 'btn', onClick: () => renderLogs() }, 'キャンセル'),
      h('button', { class: 'btn primary', onClick: save }, '保存'));
    form.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) save(); if (e.key === 'Escape') renderLogs(); });
    row.replaceChildren(form);
    name.focus();
    name.select();
  }

  async function resumeLog(id) {
    const log = await api.getLog(id);
    if (!log) { toast('作業ログを読み込めませんでした'); refreshLogs(); return; }
    const info = await findVideo(log);
    if (info) openWork(log, info);
  }

  // 作業ログの動画を見つける。前回の場所 → 選んでもらう、の順に、指紋か長さで同じ動画かを確かめる。
  // 見つからない・違う動画のときは知らせて null
  async function findVideo(log) {
    let info = null;
    const last = log.video && log.video.lastPath;
    if (last && await api.videoExists(last)) {
      const i = await api.inspectVideo(last);
      if (i.ok && i.fingerprint === log.video.fingerprint) info = i;
      else if (i.ok && (await sameVideoByDuration(log, i)).same) {
        if (!await api.confirmVideoSwap(i.fileName)) return null;
        info = i;
      }
    }
    if (!info) {
      const p = await api.chooseVideo(`動画を選んでください（前回：${(log.video && log.video.fileName) || '不明'}）`);
      if (!p) return null;
      const i = await api.inspectVideo(p);
      if (!i.ok) { toast(i.reason); return null; }
      if (i.fingerprint !== log.video.fingerprint) {
        const check = await sameVideoByDuration(log, i);
        if (!check.same) { toast(check.reason || 'この作業の動画と違います'); return null; }
        if (!await api.confirmVideoSwap(i.fileName)) return null;
      }
      info = i;
    }
    if (info.fingerprint !== log.video.fingerprint) {
      // ダウンロードし直した動画など。次からはこの動画を同じものとして扱う
      log.video.fingerprint = info.fingerprint;
      log.video.size = info.size;
      const r = await api.saveLog(log);
      if (!r || !r.ok) toast('作業ログを保存できませんでした');
    }
    return info;
  }

  // 長さを ffmpeg で調べて比べる。調べられなかったとき（時間切れ・起動できない・読み取れない）はその理由も返す
  async function sameVideoByDuration(log, info) {
    const p = await api.probeVideo(info.path);
    if (!p || !p.ok) return { same: false, reason: (p && p.reason) || null };
    return { same: C.sameDuration(log.video && log.video.duration, p.duration), reason: null };
  }

  async function importLog() {
    const r = await api.importLog();
    if (r && r.ok) { toast('作業ログを読み込みました'); showLauncher('logs'); }
    else if (r && r.reason) toast(r.reason);
  }

  // 新しく始める
  function renderNew() {
    const box = $('newStep');
    box.replaceChildren();
    const f = state.newFlow;
    if (!f || f.step === 'pick') {
      const drop = h('div', { class: 'drop' },
        h('p', { class: 'drop-title' }, '試合の動画をここにドロップ'),
        h('p', { class: 'dim', style: 'margin:0' }, 'または'),
        h('button', { class: 'btn primary', onClick: pickNewVideo }, '動画を選ぶ'));
      drop.addEventListener('dragenter', () => drop.classList.add('over'));
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', () => drop.classList.remove('over'));
      box.append(drop);
      return;
    }
    if (f.step === 'info') {
      const name = h('input', { class: 'field', id: 'gameName', value: f.gameName, onInput: e => { f.gameName = e.target.value; } });
      const a = h('input', { class: 'field', id: 'teamA', value: f.teamA, placeholder: '例：順天堂', onInput: e => { f.teamA = e.target.value; pushKeyData(); } });
      const b = h('input', { class: 'field', id: 'teamB', value: f.teamB, placeholder: '例：渡辺組', onInput: e => { f.teamB = e.target.value; pushKeyData(); } });
      const next = () => {
        if (state.settings.showShortcutsBeforeTagging) { f.step = 'shortcuts'; renderNew(); } else beginTagging();
      };
      box.append(
        h('div', { class: 'file-line' }, '動画：', h('strong', {}, f.info.fileName)),
        h('div', { class: 'form' },
          h('label', { for: 'gameName' }, '試合名'), name,
          h('label', { for: 'teamA' }, 'チームA'), a,
          h('label', { for: 'teamB' }, 'チームB'), b),
        h('p', { class: 'dim' }, 'チーム名は空でも始められます。あとから作業ログで直せます。'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onClick: () => { state.newFlow = null; renderNew(); } }, '戻る'),
          h('button', { class: 'btn primary', id: 'newNext', onClick: next }, state.settings.showShortcutsBeforeTagging ? '次へ' : 'タグ付けを始める')));
      for (const inp of [name, a, b]) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) next(); });
      name.focus();
      name.select();
      return;
    }
    if (f.step === 'shortcuts') {
      const editor = h('div', { class: 'settings' });
      box.append(
        h('p', { class: 'lead' }, 'この試合で使うショートカットです。直してから始められます。'),
        editor,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onClick: () => { f.step = 'info'; renderNew(); } }, '戻る'),
          h('button', { class: 'btn primary', id: 'beginTagging', onClick: beginTagging }, 'タグ付けを始める')));
      renderShortcutEditor(editor);
    }
  }

  async function pickNewVideo() {
    const p = await api.chooseVideo();
    if (p) startNewWith(p);
  }

  async function startNewWith(p) {
    if (!p) return;
    const info = await api.inspectVideo(p);
    if (!info.ok) { toast(info.reason); return; }
    const existing = await api.findLogByFingerprint(info.fingerprint);
    if (existing) {
      toast('この動画の作業ログがあったので、続きから開きます');
      openWork(existing, info);
      return;
    }
    state.newFlow = { step: 'info', info, gameName: baseName(info.fileName), teamA: '', teamB: '' };
    if (state.view !== 'launcher' || state.pane !== 'new') showLauncher('new'); else renderNew();
  }

  function beginTagging() {
    const f = state.newFlow;
    if (!f) return;
    const now = new Date().toISOString();
    const log = {
      version: 1,
      id: uuid(),
      createdAt: now,
      updatedAt: now,
      gameName: f.gameName.trim() || baseName(f.info.fileName),
      teamA: f.teamA.trim(),
      teamB: f.teamB.trim(),
      video: { fingerprint: f.info.fingerprint, fileName: f.info.fileName, lastPath: f.info.path, size: f.info.size, duration: null },
      lastPosition: 0,
      nextSeq: 1,
      scenes: [],
      shortcutNames: {}
    };
    state.newFlow = null;
    openWork(log, f.info);
  }

  // 動画を結合
  function renderMerge() {
    const m = state.merge;
    const box = $('mergeBody');
    box.replaceChildren();
    if (m.phase === 'running') {
      box.append(
        h('p', {}, `「${m.title}」を作っています…`),
        h('div', { class: 'progress' }, h('div', { id: 'mergeBar', style: `width:${Math.round(m.progress * 100)}%` })),
        h('div', { class: 'progress-line' }, h('span', { id: 'mergePct' }, `${Math.round(m.progress * 100)}%`), h('span')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onClick: () => api.cancelJob() }, '中止')));
      return;
    }
    if (m.phase === 'done') {
      box.append(
        h('p', {}, '結合しました。'),
        h('p', { class: 'names' }, m.output),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onClick: () => { resetMerge(); renderMerge(); } }, 'ここで終わる'),
          h('button', { class: 'btn primary', onClick: () => { const out = m.output; resetMerge(); startNewWith(out); } }, 'そのままタグ付けに入る')));
      return;
    }
    const list = h('div', { class: 'mfiles' });
    m.files.forEach((f, i) => list.append(mergeRow(f, i)));
    const title = h('input', { class: 'field', id: 'mergeTitle', value: m.title, style: 'width:100%', onInput: e => { m.title = e.target.value; } });
    const q = (val, label, desc) => h('label', {},
      h('input', { type: 'radio', name: 'mq', value: val, checked: m.quality === val, onChange: () => { m.quality = val; } }),
      h('span', {}, h('span', {}, label), h('br'), h('span', { class: 'desc' }, desc)));
    box.append(
      m.files.length ? list : h('div', { class: 'drop', style: 'padding:28px' }, h('p', { class: 'drop-title' }, '結合する動画をここにドロップ'), h('p', { class: 'dim', style: 'margin:0' }, '上から順につなぎます')),
      h('button', { class: 'btn', onClick: async () => addMergeFiles(await api.chooseVideos()) }, '＋ 動画を追加'),
      h('div', { class: 'form', style: 'margin-top:26px' },
        h('label', { for: 'mergeTitle' }, 'タイトル'), title,
        h('label', {}, '画質'),
        h('div', { class: 'choice' },
          q('source', '元のまま', '画質が落ちず、数分で終わります。同じカメラ・同じ設定で撮った動画同士だけ'),
          q('1080p', '1080p', '形式が違う動画同士でも結合できます'),
          q('720p', '720p', '形式が違う動画同士でも結合でき、ファイルが軽くなります'))),
      h('div', { class: 'actions' },
        m.files.length < 2 ? h('span', { class: 'dim', style: 'align-self:center' }, '2本以上追加してください') : null,
        h('button', { class: 'btn primary', id: 'mergeStart', disabled: m.files.length < 2, onClick: startMerge }, '保存先を選んで結合')));
  }

  function mergeRow(f, i) {
    const m = state.merge;
    const row = h('div', { class: 'mfile', draggable: 'true', dataset: { index: String(i) } },
      h('span', { class: 'handle dim', title: 'ドラッグで並べ替え' }, icon('i-drag')),
      h('span', { class: 'num' }, `${i + 1}`),
      h('span', { class: 'name', title: f.path }, f.name),
      h('span', { class: 'meta' }, f.duration ? C.formatTime(f.duration) : ''),
      h('span', { class: 'meta' }, f.video ? `${f.video.width}×${f.video.height}` : ''),
      h('button', { class: 'icon-btn', 'aria-label': `${f.name} を外す`, onClick: () => { m.files.splice(i, 1); renderMerge(); } }, icon('i-x')));
    row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-moment-merge', String(i)); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-moment-merge')) { e.preventDefault(); row.classList.add('drop-before'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', e => {
      const from = Number(e.dataTransfer.getData('text/x-moment-merge'));
      if (!Number.isInteger(from)) return;
      e.preventDefault();
      e.stopPropagation();
      const [it] = m.files.splice(from, 1);
      m.files.splice(from < i ? i - 1 : i, 0, it);
      renderMerge();
    });
    return row;
  }

  async function addMergeFiles(paths) {
    const m = state.merge;
    for (const p of paths || []) {
      if (!p) continue;
      const info = await api.probeVideo(p);
      if (!info || !info.ok) {
        // 時間切れと起動できないときはその理由、読み取れないときは「〜 を読み込めません」
        const why = info && (info.error === 'timeout' || info.error === 'spawn') ? info.reason : `${p.split(/[\\/]/).pop()} を読み込めません`;
        toast(why);
        continue;
      }
      m.files.push({ path: p, name: p.split(/[\\/]/).pop(), duration: info.duration, video: info.video });
    }
    if (!m.title && m.files.length) m.title = baseName(m.files[0].name);
    renderMerge();
  }

  function resetMerge() { state.merge = { files: [], title: '', quality: 'source', phase: 'edit', progress: 0, output: null }; }

  // プレイリスト
  function newPlaylist(name) {
    const now = new Date().toISOString();
    return { version: 1, id: uuid(), createdAt: now, updatedAt: now, name: String(name || '').trim() || '新しいプレイリスト', items: [] };
  }

  async function refreshPlaylists() {
    state.pls = await api.listPlaylists();
    renderPlaylists();
  }

  function renderPlaylists() {
    const box = $('plList');
    box.replaceChildren();
    if (state.plNew) box.append(newPlaylistRow());
    if (!state.pls.length && !state.plNew) {
      box.append(h('div', { class: 'empty' },
        h('p', {}, 'まだプレイリストがありません。'),
        h('p', {}, '作業画面のタグ一覧でシーンにチェックを入れ、「プレイリストに追加」で入れます。')));
      return;
    }
    for (const p of state.pls) box.append(playlistRow(p));
  }

  function newPlaylistRow() {
    const name = h('input', { class: 'field', placeholder: '例：渡辺組 FB', 'aria-label': 'プレイリストの名前' });
    const create = async () => {
      const r = await api.savePlaylist(newPlaylist(name.value));
      if (!r || !r.ok) toast('プレイリストを保存できませんでした');
      state.plNew = false;
      refreshPlaylists();
    };
    const cancel = () => { state.plNew = false; renderPlaylists(); };
    const form = h('div', { class: 'pl-edit' }, name,
      h('button', { class: 'btn', onClick: cancel }, 'キャンセル'),
      h('button', { class: 'btn primary', onClick: create }, '作る'));
    form.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) create(); if (e.key === 'Escape') cancel(); });
    setTimeout(() => name.focus(), 0);
    return h('div', { class: 'log-row' }, form);
  }

  function playlistRow(p) {
    const row = h('div', { class: 'log-row' });
    const main = h('button', { class: 'log-main', onClick: () => openPlaylist(p.id) },
      h('span', { class: 'log-name' }, p.name || 'プレイリスト'),
      h('span', { class: 'log-cell' }, p.broken ? '読み込めません' : `${p.itemCount}本`),
      h('span', { class: 'log-cell' }, p.broken ? '' : C.formatTimeShort(p.totalSec)),
      h('span', { class: 'log-cell date' }, fmtDate(p.updatedAt)));
    const actions = h('div', { class: 'log-actions' },
      p.broken ? null : h('button', { class: 'btn small', onClick: () => editPlaylistRow(row, p) }, '名前を変える'),
      h('button', { class: 'btn small danger', onClick: async () => { if (await api.deletePlaylist(p.id, p.name)) refreshPlaylists(); } }, '削除'));
    row.append(main, actions);
    return row;
  }

  function editPlaylistRow(row, p) {
    const name = h('input', { class: 'field', value: p.name || '', 'aria-label': 'プレイリストの名前' });
    const save = async () => {
      const pl = await api.getPlaylist(p.id);
      if (!pl) { toast('プレイリストを読み込めませんでした'); refreshPlaylists(); return; }
      pl.name = name.value.trim() || pl.name;
      const r = await api.savePlaylist(pl);
      if (!r || !r.ok) toast('プレイリストを保存できませんでした');
      refreshPlaylists();
    };
    const form = h('div', { class: 'pl-edit' }, name,
      h('button', { class: 'btn', onClick: () => renderPlaylists() }, 'キャンセル'),
      h('button', { class: 'btn primary', onClick: save }, '保存'));
    form.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) save(); if (e.key === 'Escape') renderPlaylists(); });
    row.replaceChildren(form);
    name.focus();
    name.select();
  }

  async function startMerge() {
    const m = state.merge;
    if (m.files.length < 2) return;
    const firstExt = (m.files[0].name.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
    const ext = m.quality === 'source' ? firstExt : '.mp4';
    let out = await api.saveVideoAs(`${C.sanitizeFileName(m.title || '結合した動画')}${ext}`);
    if (!out) return;
    if (!/\.[A-Za-z0-9]{2,4}$/.test(out)) out += ext;
    m.phase = 'running';
    m.progress = 0;
    renderMerge();
    const off = api.on('job:event', ev => {
      if (ev.type !== 'progress') return;
      m.progress = ev.fraction || 0;
      const bar = $('mergeBar'); const pct = $('mergePct');
      if (bar) bar.style.width = `${Math.round(m.progress * 100)}%`;
      if (pct) pct.textContent = `${Math.round(m.progress * 100)}%`;
    });
    const r = await api.startMerge({ inputs: m.files.map(f => f.path), output: out, quality: m.quality });
    off();
    if (r.ok) { m.phase = 'done'; m.output = r.output; }
    else { m.phase = 'edit'; toast(r.cancelled ? '結合を中止しました' : r.reason); }
    renderMerge();
  }

  // ---------- 設定画面 ----------
  function renderSettings(box) {
    box.replaceChildren();
    const s = state.settings;
    box.classList.add('settings');

    const sc = h('div');
    box.append(h('h2', {}, 'ショートカット'),
      h('p', { class: 'note' }, '押すと、その名前がタグになります。チームをA・Bにすると、タイトルの前にその試合のチーム名が付きます。'),
      sc);
    renderShortcutEditor(sc);

    const base = h('div', { class: 'kv' });
    for (const a of C.BASE_ACTIONS) {
      base.append(h('div', { class: 'kv-row' }, h('span', { class: 'label' }, a.label), keyButton({ kind: 'base', id: a.id }, s.baseKeys[a.id])));
    }
    box.append(h('h2', {}, '基本操作のキー'), h('p', { class: 'note' }, '名前は変えられません。キーだけ変えられます。'), base);

    box.append(h('h2', {}, 'タグ付け'),
      h('label', { class: 'check-line' },
        h('input', { type: 'checkbox', checked: s.showShortcutsBeforeTagging, onChange: e => { s.showShortcutsBeforeTagging = e.target.checked; saveSettings(); } }),
        'タグ付けを始める前にショートカット設定を表示する'),
      h('div', { class: 'section-title dim', style: 'margin-top:8px' }, 'あとからタグを付ける方法'),
      h('div', { class: 'choice' },
        h('label', {}, h('input', { type: 'radio', name: 'addTag', checked: s.addTagMethod === 'key', onChange: () => { s.addTagMethod = 'key'; saveSettings(); rerenderRows(); } }),
          h('span', {}, 'キーで付ける', h('br'), h('span', { class: 'desc' }, '一覧で行を選んでショートカットを押すと付きます。もう一度押すと外れます'))),
        h('label', {}, h('input', { type: 'radio', name: 'addTag', checked: s.addTagMethod === 'mouse', onChange: () => { s.addTagMethod = 'mouse'; saveSettings(); rerenderRows(); } }),
          h('span', {}, 'マウスで付ける', h('br'), h('span', { class: 'desc' }, 'タグの欄をクリックして、一覧から選びます')))));

    const quality = h('select', { class: 'field', onChange: e => { s.exportQuality = e.target.value; saveSettings(); } },
      ...[['source', '元の解像度'], ['1080p', '1080p'], ['720p', '720p']].map(([v, t]) => h('option', { value: v, selected: s.exportQuality === v }, t)));
    const dirText = h('span', { class: 'path', title: s.exportDir || '' }, s.exportDir ? shortPath(s.exportDir) : '未選択');
    box.append(h('h2', {}, 'ダウンロード'),
      h('div', { class: 'kv' },
        h('div', { class: 'kv-row' }, h('span', { class: 'label' }, '画質'), quality),
        h('div', { class: 'kv-row' }, h('span', { class: 'label' }, '保存先'),
          h('span', { style: 'display:flex;gap:10px;align-items:center;min-width:0' }, dirText,
            h('button', { class: 'btn small', onClick: async () => { const d = await api.chooseFolder(s.exportDir); if (d) { s.exportDir = d; dirText.textContent = shortPath(d); dirText.title = d; saveSettings(); } } }, '変更')))));

    const theme = (val, label) => h('label', {}, h('input', { type: 'radio', name: 'theme', checked: s.theme === val, onChange: () => { s.theme = val; saveSettings(); } }), label);
    box.append(h('h2', {}, '表示'),
      h('div', { class: 'radio-row', style: 'padding:10px 0' }, theme('light', 'ライト'), theme('dark', 'ダーク'), theme('system', isWin ? 'Windowsの設定に合わせる' : 'Macの設定に合わせる')));
  }

  function keyButton(owner, combo) {
    const btn = h('button', { class: 'keybtn', 'aria-label': 'キーを割り当てる' });
    if (combo && combo.code) btn.append(kbd(L(combo))); else btn.append(h('span', { class: 'unset' }, '未設定'));
    btn.addEventListener('click', () => startCapture(owner, btn));
    return btn;
  }

  function renderShortcutEditor(box) {
    box.replaceChildren();
    const s = state.settings;
    const g = keyGame();
    const head = h('div', { class: 'sc-head' }, h('span'), h('span', {}, 'チーム'), h('span', {}, '名前'), h('span', {}, 'キー'), h('span'));
    const list = h('div');
    s.shortcuts.forEach((sc, i) => {
      const team = h('select', { class: 'field', 'aria-label': 'チーム', onChange: e => { sc.team = e.target.value || null; saveSettings(); rerenderRows(); } },
        h('option', { value: 'A', selected: sc.team === 'A' }, g && g.teamA ? `A：${g.teamA}` : 'A'),
        h('option', { value: 'B', selected: sc.team === 'B' }, g && g.teamB ? `B：${g.teamB}` : 'B'),
        h('option', { value: '', selected: !sc.team }, 'なし'));
      const name = h('input', { class: 'field', value: sc.name, 'aria-label': '名前' });
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) { toast('名前を入れてください'); name.value = sc.name; return; }
        sc.name = v;
        saveSettings();
        rerenderRows();
      });
      name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) name.blur(); });
      const del = h('button', {
        class: 'icon-btn', 'aria-label': `${sc.name} を削除`, onClick: () => {
          s.shortcuts.splice(i, 1);
          s.deletedShortcuts = (s.deletedShortcuts || []).filter(d => d.id !== sc.id).concat([{ id: sc.id, name: sc.name, team: sc.team }]);
          saveSettings();
          renderShortcutEditor(box);
          toast(`「${sc.name}」を削除しました。過去のタグは残ります`);
        }
      }, icon('i-x'));
      const handle = h('span', { class: 'handle', title: 'ドラッグで並べ替え' }, icon('i-drag'));
      const row = h('div', { class: 'sc-row', draggable: 'true' }, handle, team, name, keyButton({ kind: 'shortcut', id: sc.id }, sc.key), del);
      row.addEventListener('dragstart', e => {
        if (isTyping(document.activeElement)) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/x-moment-sc', String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-moment-sc')) { e.preventDefault(); row.classList.add('drop-before'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
      row.addEventListener('drop', e => {
        const from = Number(e.dataTransfer.getData('text/x-moment-sc'));
        if (!Number.isInteger(from)) return;
        e.preventDefault();
        e.stopPropagation();
        const [it] = s.shortcuts.splice(from, 1);
        s.shortcuts.splice(from < i ? i - 1 : i, 0, it);
        saveSettings();
        renderShortcutEditor(box);
      });
      list.append(row);
    });
    const add = h('button', {
      class: 'btn sc-add', onClick: () => {
        const sc = { id: uuid(), team: null, name: '新しいタグ', key: { code: '', shift: false, meta: false, alt: false } };
        s.shortcuts.push(sc);
        saveSettings();
        renderShortcutEditor(box);
        const inputs = box.querySelectorAll('.sc-row input.field');
        const last = inputs[inputs.length - 1];
        if (last) { last.focus(); last.select(); }
      }
    }, '＋ ショートカットを追加');
    box.append(head, list, add);
  }

  function startCapture(owner, btn) {
    endCapture();
    state.capture = { owner, btn };
    btn.classList.add('capturing');
    btn.replaceChildren('キーを押してください');
  }
  function endCapture() {
    const cap = state.capture;
    state.capture = null;
    if (!cap) return;
    const combo = cap.owner.kind === 'base' ? state.settings.baseKeys[cap.owner.id] : (state.settings.shortcuts.find(s => s.id === cap.owner.id) || {}).key;
    cap.btn.classList.remove('capturing');
    cap.btn.replaceChildren(combo && combo.code ? kbd(L(combo)) : h('span', { class: 'unset' }, '未設定'));
  }
  function handleCapture(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { endCapture(); return; }
    if (C.MODIFIER_CODES.includes(e.code) || e.isComposing) return;
    const combo = C.comboFromEvent(e);
    const owner = state.capture.owner;
    const problem = C.keyProblem(combo, state.settings, owner);
    if (problem) { toast(problem); return; }
    if (owner.kind === 'base') state.settings.baseKeys[owner.id] = combo;
    else { const sc = state.settings.shortcuts.find(s => s.id === owner.id); if (sc) sc.key = combo; }
    endCapture();
    saveSettings();
  }

  // ---------- 作業画面 ----------
  function openWork(log, info) {
    leavePlaylist();
    closePopover();
    state.game = log;
    state.video = info;
    state.pending = null;
    state.selectedId = null;
    state.checked = new Set();
    state.undo = [];
    state.redo = [];
    state.stopAt = null;
    state.filter = 'all';
    state.memoQuery = '';
    $('memoSearch').value = '';
    log.video.lastPath = info.path;
    log.video.fileName = info.fileName;
    state.view = 'work';
    $('launcher').hidden = true;
    $('work').hidden = false;
    document.title = `${info.fileName} - Moment`;
    layoutList();
    const v = $('video');
    v.src = info.url;
    setSpeed(C.SPEEDS.indexOf(1));
    renderRec();
    renderListControls();
    renderRows();
    pushKeyData();
    saveNow();
  }

  async function closeWork(pane) {
    if (state.view !== 'work') { showLauncher(pane); return; }
    if (state.sheet && state.sheet.kind === 'export' && state.sheet.st.phase === 'running') { toast('ダウンロードが終わるまでお待ちください'); return; }
    closeSheet(true);
    closePopover();
    await saveNow();
    const v = $('video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    state.game = null;
    state.video = null;
    state.pending = null;
    showLauncher(pane || 'logs');
    pushKeyData();
  }

  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
  async function saveNow() {
    clearTimeout(saveTimer);
    const g = state.game;
    if (!g) return;
    const v = $('video');
    if (Number.isFinite(v.currentTime) && v.readyState > 0) g.lastPosition = round3(v.currentTime);
    for (const sc of g.scenes) for (const id of sc.tags) {
      const s = C.resolveShortcut(id, state.settings, g.shortcutNames);
      g.shortcutNames[id] = { name: s.name, team: s.team || null };
    }
    const r = await api.saveLog(g);
    if (!r || !r.ok) toast('作業ログを保存できませんでした');
  }

  // 再生（作業画面とプレイリスト画面で、見えている方の映像を使う）
  const video = () => $(state.view === 'playlist' ? 'plVideo' : 'video');
  function now() { return round3(video().currentTime || 0); }
  function togglePlay() {
    const v = video();
    state.stopAt = null;
    if (v.paused || v.ended) v.play().catch(() => {}); else v.pause();
  }
  function seekBy(d) {
    const v = video();
    if (!Number.isFinite(v.duration)) return;
    state.stopAt = null;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + d));
  }
  // 動画を入れ替えても速度が変わらないよう、初期の速度もそろえる
  function setSpeed(i) {
    state.speedIndex = Math.max(0, Math.min(C.SPEEDS.length - 1, i));
    const sp = C.SPEEDS[state.speedIndex];
    const v = video();
    v.defaultPlaybackRate = sp;
    v.playbackRate = sp;
    for (const b of [$('btnSpeed'), $('plSpeed')]) {
      b.textContent = `${sp}倍`;
      b.classList.toggle('changed', sp !== 1);
    }
  }
  function setPlayIcon(btn, playing) {
    const use = btn.querySelector('use');
    const want = playing ? '#i-pause' : '#i-play';
    if (use.getAttribute('href') === want) return;
    use.setAttribute('href', want);
    btn.setAttribute('aria-label', playing ? '停止' : '再生');
    btn.title = playing ? '停止' : '再生';
  }
  function updateBar() {
    const v = video();
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const t = v.currentTime || 0;
    $('clock').textContent = `${C.formatTime(t)} / ${C.formatTime(d)}`;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    $('seekFill').style.width = `${pct}%`;
    $('seekThumb').style.left = `${pct}%`;
    setPlayIcon($('btnPlay'), !v.paused && !v.ended);
  }
  function tick() {
    if (state.view === 'work') {
      const v = video();
      if (state.stopAt != null && v.currentTime >= state.stopAt) {
        v.pause();
        state.stopAt = null;
      }
      updateBar();
    } else if (state.view === 'playlist') {
      plTick();
    }
    requestAnimationFrame(tick);
  }
  function playScene(s) {
    const v = video();
    v.currentTime = s.start;
    state.stopAt = s.end;
    v.play().catch(() => {});
  }

  // 記録
  function renderRec() {
    const on = !!state.pending;
    $('rec').classList.toggle('on', on);
    const t = on ? C.formatTime(state.pending.start) : '';
    $('recTime').textContent = t;
  }
  function startRecording() {
    const t = now();
    if (state.pending) state.pending.start = t;
    else state.pending = { start: t, tags: [] };
    renderRec();
    renderRows();
    $('rows').scrollTop = 0;
  }
  function endRecording() {
    const p = state.pending;
    if (!p) { toast('先に 、 で開始してください'); return; }
    const t = now();
    if (t <= p.start) { toast('終了は開始より後にしてください'); return; }
    pushUndo();
    const g = state.game;
    const scene = { id: uuid(), seq: g.nextSeq++, start: p.start, end: t, tags: p.tags.slice(), titleOverride: null, memo: '' };
    g.scenes.push(scene);
    state.pending = null;
    state.flashId = scene.id;
    renderRec();
    changed();
  }
  function cancelRecording() {
    if (!state.pending) return;
    state.pending = null;
    renderRec();
    renderRows();
  }
  function applyShortcut(sc) {
    if (state.pending) {
      const tags = state.pending.tags;
      const i = tags.indexOf(sc.id);
      if (i >= 0) tags.splice(i, 1); else tags.push(sc.id);
      renderRows();
      return;
    }
    if (state.settings.addTagMethod === 'key' && state.selectedId) {
      toggleSceneTag(state.selectedId, sc.id);
      return;
    }
    toast(state.settings.addTagMethod === 'key' ? '、 で開始するか、行を選んでから押してください' : '先に 、 で開始してください');
  }
  function toggleSceneTag(sceneId, scId) {
    const s = state.game.scenes.find(x => x.id === sceneId);
    if (!s) return;
    pushUndo();
    const i = s.tags.indexOf(scId);
    if (i >= 0) s.tags.splice(i, 1); else s.tags.push(scId);
    changed();
  }

  // 元に戻す
  function snapshot() { return JSON.stringify({ scenes: state.game.scenes, nextSeq: state.game.nextSeq }); }
  function pushUndo() {
    state.undo.push(snapshot());
    if (state.undo.length > 300) state.undo.shift();
    state.redo = [];
  }
  function restore(s) {
    const o = JSON.parse(s);
    state.game.scenes = o.scenes;
    state.game.nextSeq = o.nextSeq;
    const ids = new Set(o.scenes.map(x => x.id));
    for (const id of [...state.checked]) if (!ids.has(id)) state.checked.delete(id);
    if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
    changed();
  }
  function undo() {
    if (!state.game || !state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.game || !state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  function changed() {
    saveSoon();
    renderListControls();
    renderRows();
  }

  // 一覧
  function rowData(s) {
    const g = state.game;
    return { ...s, title: C.sceneTitle(s, g, state.settings, g.shortcutNames), team: C.sceneTeam(s, state.settings, g.shortcutNames) };
  }
  function parseFilter(v) {
    if (!v || v === 'all') return { kind: 'all' };
    const i = v.indexOf(':');
    return { kind: v.slice(0, i), value: v.slice(i + 1) };
  }
  function visibleRows() {
    const rows = state.game.scenes.map(rowData);
    return C.sortScenes(C.filterScenes(rows, parseFilter(state.filter), state.memoQuery), state.sort);
  }
  function teamVar(team) { return team === 'A' ? 'var(--team-a)' : team === 'B' ? 'var(--team-b)' : 'var(--team-none)'; }
  function tagName(id) { return C.resolveShortcut(id, state.settings, state.game.shortcutNames).name; }

  function renderListControls() {
    if (!state.game) return;
    const g = state.game;
    const sortSel = $('sortSel');
    sortSel.replaceChildren(...C.SORTS.map(s => h('option', { value: s.id, selected: s.id === state.sort }, s.label)));
    const rows = g.scenes.map(rowData);
    const titles = [...new Set(rows.map(r => r.title).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    const tagIds = [...new Set(g.scenes.flatMap(s => s.tags))];
    const opts = [h('option', { value: 'all' }, 'すべて')];
    opts.push(h('optgroup', { label: 'チーム' },
      h('option', { value: 'team:A' }, C.teamName(g, 'A')),
      h('option', { value: 'team:B' }, C.teamName(g, 'B'))));
    if (titles.length) opts.push(h('optgroup', { label: 'タイトル' }, ...titles.map(t => h('option', { value: `title:${t}` }, t))));
    if (tagIds.length) opts.push(h('optgroup', { label: 'タグ' }, ...tagIds.map(id => h('option', { value: `tag:${id}` }, tagName(id)))));
    const filterSel = $('filterSel');
    filterSel.replaceChildren(...opts);
    filterSel.value = state.filter;
    if (filterSel.value !== state.filter) { state.filter = 'all'; filterSel.value = 'all'; }
  }

  function rerenderRows() {
    if (state.view === 'work' && state.game) { renderListControls(); renderRows(); pushKeyData(); }
    if (state.view === 'playlist' && state.pl) renderPlaylistView();
  }

  function renderRows() {
    if (!state.game) return;
    const box = $('rows');
    const keepScroll = box.scrollTop;
    box.replaceChildren();
    if (state.pending) box.append(pendingRow());
    const rows = visibleRows();
    for (const r of rows) box.append(sceneRow(r));
    if (!rows.length && !state.pending) {
      box.append(state.game.scenes.length
        ? h('div', { class: 'list-empty' }, '絞り込みに合うシーンがありません。')
        : h('div', { class: 'list-empty' }, kbd(L(state.settings.baseKeys.start)), '開始 → ショートカットでタグ →', kbd(L(state.settings.baseKeys.end)), '終了。シーンはここに溜まっていきます。'));
    }
    box.scrollTop = keepScroll;
    const total = state.game.scenes.length;
    $('rowCount').textContent = rows.length === total ? `${total}件` : `${rows.length}件 / 全${total}件`;
    const visibleIds = rows.map(r => r.id);
    const ca = $('checkAll');
    const checkedVisible = visibleIds.filter(id => state.checked.has(id)).length;
    ca.checked = visibleIds.length > 0 && checkedVisible === visibleIds.length;
    ca.indeterminate = checkedVisible > 0 && checkedVisible < visibleIds.length;
    const n = state.game.scenes.filter(s => state.checked.has(s.id)).length;
    $('btnAddToPl').disabled = n === 0;
    const ex = $('btnExport');
    ex.disabled = n === 0;
    ex.textContent = n ? `ダウンロード（${n}）` : 'ダウンロード';
    if (state.flashId) {
      const el = box.querySelector(`[data-id="${CSS.escape(state.flashId)}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest' }); }
      state.flashId = null;
    }
  }

  function chips(tags) { return tags.map(id => h('span', { class: 'chip' }, tagName(id))); }

  function pendingRow() {
    const p = state.pending;
    const g = state.game;
    const team = C.sceneTeam({ tags: p.tags }, state.settings, g.shortcutNames);
    const title = C.autoTitle(p.tags, g, state.settings, g.shortcutNames);
    const row = h('div', { class: 'row pending', role: 'listitem' },
      h('span', { class: 'team-bar' }),
      h('span'),
      h('span', { class: 'cell times' }, C.formatTimeShort(p.start), h('span', { class: 'arrow' }, '→'), h('span', { class: 'recording' }, '記録中')),
      h('span', { class: 'cell title' }, title || ''),
      h('span', { class: 'cell tags' }, chips(p.tags)),
      h('span', { class: 'cell memo' }));
    row.style.setProperty('--team', teamVar(team));
    return row;
  }

  function field(r, name, text, placeholder) {
    return h('span', { class: `f${placeholder ? ' ph' : ''}`, dataset: { field: name } }, text);
  }

  function sceneRow(r) {
    const mouseTags = state.settings.addTagMethod === 'mouse';
    const row = h('div', { class: `row${r.id === state.selectedId ? ' selected' : ''}${mouseTags ? ' mouse-tags' : ''}`, role: 'listitem', dataset: { id: r.id } });
    row.style.setProperty('--team', teamVar(r.team));
    const check = h('input', { type: 'checkbox', checked: state.checked.has(r.id), 'aria-label': 'ダウンロードする' });
    check.addEventListener('click', e => {
      e.stopPropagation();
      if (e.target.checked) state.checked.add(r.id); else state.checked.delete(r.id);
      renderRows();
    });
    const tags = h('span', { class: 'cell tags' }, chips(r.tags));
    row.append(
      h('span', { class: 'team-bar' }),
      h('label', { class: 'check', onClick: e => e.stopPropagation() }, check),
      h('span', { class: 'cell times' }, field(r, 'start', C.formatTimeShort(r.start)), h('span', { class: 'arrow' }, '→'), field(r, 'end', C.formatTimeShort(r.end))),
      h('span', { class: 'cell title' }, field(r, 'title', r.title || 'タイトルなし', !r.title)),
      tags,
      h('span', { class: 'cell memo' }, field(r, 'memo', r.memo || 'メモ', !r.memo)));
    row.addEventListener('click', e => {
      if (e.target.closest('input.edit')) return;
      if (mouseTags && e.target.closest('.tags')) { e.stopPropagation(); select(r.id); openTagPopover(r.id, tags); return; }
      const f = e.target.closest('.f');
      if (f && state.selectedId === r.id) { startEdit(r.id, f.dataset.field); return; }
      select(r.id);
      playScene(r);
    });
    row.addEventListener('dblclick', e => {
      const f = e.target.closest('.f');
      if (f) startEdit(r.id, f.dataset.field);
    });
    return row;
  }

  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    for (const el of $('rows').querySelectorAll('.row[data-id]')) el.classList.toggle('selected', el.dataset.id === id);
  }

  function startEdit(id, fieldName) {
    const box = $('rows');
    const row = box.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const span = row.querySelector(`.f[data-field="${fieldName}"]`);
    if (!span || row.querySelector('input.edit')) return;
    const s = state.game.scenes.find(x => x.id === id);
    if (!s) return;
    if (state.selectedId !== id) select(id);
    const r = rowData(s);
    const value = fieldName === 'start' ? C.formatTimeShort(s.start) : fieldName === 'end' ? C.formatTimeShort(s.end) : fieldName === 'title' ? (r.title || '') : (s.memo || '');
    const input = h('input', { class: 'edit', value, 'aria-label': { start: '開始', end: '終了', title: 'タイトル', memo: 'メモ' }[fieldName] });
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      if (commit) commitEdit(id, fieldName, input.value);
      else renderRows();
    };
    input.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('dblclick', e => e.stopPropagation());
    span.replaceWith(input);
    input.focus();
    input.select();
  }

  function commitEdit(id, fieldName, raw) {
    const s = state.game.scenes.find(x => x.id === id);
    if (!s) { renderRows(); return; }
    if (fieldName === 'start' || fieldName === 'end') {
      const old = fieldName === 'start' ? s.start : s.end;
      if (String(raw).trim() === C.formatTimeShort(old)) { renderRows(); return; }
      const sec = C.parseTime(raw);
      if (sec == null) { toast('時刻は 52:39 のように入れてください'); renderRows(); return; }
      const ns = fieldName === 'start' ? sec : s.start;
      const ne = fieldName === 'end' ? sec : s.end;
      const dur = video().duration;
      if (ne <= ns) { toast('終了は開始より後にしてください'); renderRows(); return; }
      if (ns < 0 || (Number.isFinite(dur) && ne > dur + 0.5)) { toast('動画の範囲内の時刻にしてください'); renderRows(); return; }
      pushUndo();
      if (fieldName === 'start') s.start = ns; else s.end = Math.min(ne, Number.isFinite(dur) ? dur : ne);
      changed();
      return;
    }
    if (fieldName === 'title') {
      const v = String(raw).trim();
      const auto = C.autoTitle(s.tags, state.game, state.settings, state.game.shortcutNames);
      const next = !v || v === auto ? null : v;
      if (next === (s.titleOverride || null)) { renderRows(); return; }
      pushUndo();
      s.titleOverride = next;
      changed();
      return;
    }
    if (fieldName === 'memo') {
      if (raw === (s.memo || '')) { renderRows(); return; }
      pushUndo();
      s.memo = raw;
      changed();
    }
  }

  function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;
    const i = state.game.scenes.findIndex(s => s.id === id);
    if (i < 0) return;
    pushUndo();
    state.game.scenes.splice(i, 1);
    state.checked.delete(id);
    state.selectedId = null;
    changed();
  }

  // タグの一覧（マウスで付ける）
  function openTagPopover(sceneId, anchor) {
    const pop = $('popover');
    const draw = () => {
      const s = state.game.scenes.find(x => x.id === sceneId);
      if (!s) { closePopover(); return; }
      pop.replaceChildren(...state.settings.shortcuts.map(sc => h('button', {
        class: 'pop-item', onClick: e => { e.stopPropagation(); toggleSceneTag(sceneId, sc.id); draw(); }
      },
        h('span', { class: 'tick' }, s.tags.includes(sc.id) ? '✓' : ''),
        h('span', { class: 'team-dot', style: `background:${teamVar(sc.team)}` }),
        sc.team ? `${C.teamName(state.game, sc.team)} ${sc.name}` : sc.name)));
    };
    draw();
    showPopover(anchor);
  }
  function showPopover(anchor) {
    const pop = $('popover');
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const ph = pop.offsetHeight;
    const pw = pop.offsetWidth;
    let y = r.bottom + 4;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 4);
    pop.style.top = `${y}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - pw - 8)}px`;
  }
  function closePopover() { $('popover').hidden = true; }

  function openSpeedPopover() {
    const pop = $('popover');
    pop.replaceChildren(...C.SPEEDS.map((sp, i) => h('button', { class: 'pop-item', onClick: () => { setSpeed(i); closePopover(); } },
      h('span', { class: 'tick' }, i === state.speedIndex ? '✓' : ''), `${sp}倍`)));
    showPopover($(state.view === 'playlist' ? 'plSpeed' : 'btnSpeed'));
  }

  // ---------- プレイリストに追加（作業画面） ----------
  async function openAddToPlaylist() {
    if (state.view !== 'work' || !state.game) return;
    const n = state.game.scenes.filter(s => state.checked.has(s.id)).length;
    if (!n) return;
    const pls = (await api.listPlaylists()).filter(p => !p.broken);
    const pop = $('popover');
    const anchor = $('btnAddToPl');
    const askName = () => {
      const name = h('input', { class: 'field', placeholder: '新しいプレイリストの名前', 'aria-label': '新しいプレイリストの名前' });
      const go = () => { closePopover(); addCheckedToPlaylist({ name: name.value }); };
      name.addEventListener('keydown', e => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); go(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); }
      });
      pop.replaceChildren(h('div', { class: 'pop-form' }, name, h('button', { class: 'btn primary small', onClick: go }, '作って追加')));
      showPopover(anchor);
      name.focus();
    };
    pop.replaceChildren(
      h('div', { class: 'pop-head' }, `${n}本を入れるプレイリスト`),
      ...pls.map(p => h('button', { class: 'pop-item', onClick: () => { closePopover(); addCheckedToPlaylist({ id: p.id }); } },
        h('span', { class: 'pop-name' }, p.name || 'プレイリスト'), h('span', { class: 'dim' }, `${p.itemCount}本`))),
      pls.length ? h('div', { class: 'pop-sep' }) : null,
      // 中身を入れ替えるので、外側のクリックとして閉じないよう止める
      h('button', { class: 'pop-item', onClick: e => { e.stopPropagation(); askName(); } }, '＋ 新しいプレイリスト'));
    showPopover(anchor);
  }

  // チェックした行を、試合の時刻順でプレイリストの最後に入れる。同じシーンは1回だけ
  async function addCheckedToPlaylist(target) {
    const g = state.game;
    if (!g) return;
    const scenes = g.scenes.filter(s => state.checked.has(s.id)).sort((a, b) => a.start - b.start || a.seq - b.seq);
    if (!scenes.length) return;
    await saveNow(); // 入れるシーンが作業ログに書かれているようにする
    const pl = target.id ? await api.getPlaylist(target.id) : newPlaylist(target.name);
    if (!pl) { toast('プレイリストを読み込めませんでした'); return; }
    const have = new Set(pl.items.map(it => `${it.logId}/${it.sceneId}`));
    let added = 0;
    for (const s of scenes) {
      if (have.has(`${g.id}/${s.id}`)) continue;
      pl.items.push({ logId: g.id, sceneId: s.id });
      have.add(`${g.id}/${s.id}`);
      added++;
    }
    if (added) {
      const r = await api.savePlaylist(pl);
      if (!r || !r.ok) { toast('プレイリストを保存できませんでした'); return; }
    }
    const dup = scenes.length - added;
    toast(`「${pl.name}」に${added}本を追加しました${dup ? `（${dup}本はすでに入っています）` : ''}`);
  }

  // ---------- プレイリスト画面 ----------
  const plKey = it => `${it.logId}/${it.sceneId}`;

  // 前回の場所に同じ動画（指紋が同じ）があれば使う。ここではたずねない（見つからなければ行をクリックして選ぶ）
  async function quickVideo(log) {
    const last = log.video && log.video.lastPath;
    if (!last || !await api.videoExists(last)) return null;
    const i = await api.inspectVideo(last);
    return i.ok && i.fingerprint === log.video.fingerprint ? i : null;
  }

  async function openPlaylist(id) {
    const playlist = await api.getPlaylist(id);
    if (!playlist) { toast('プレイリストを読み込めませんでした'); refreshPlaylists(); return; }
    const logs = new Map();
    const videos = new Map();
    for (const logId of new Set(playlist.items.map(it => it.logId))) {
      const log = await api.getLog(logId).catch(() => null);
      logs.set(logId, log);
      videos.set(logId, log ? await quickVideo(log) : null);
    }
    closePopover();
    state.pl = { playlist, logs, videos, current: null, selected: null, loading: false, url: null };
    state.view = 'playlist';
    $('launcher').hidden = true;
    $('work').hidden = true;
    $('plView').hidden = false;
    document.title = `${playlist.name || 'プレイリスト'} - Moment`;
    layoutList();
    setSpeed(C.SPEEDS.indexOf(1));
    renderPlaylistView();
  }

  // プレイリスト画面を閉じる（映像を止めて外す）
  function leavePlaylist() {
    if (!state.pl) return;
    const v = $('plVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
    state.pl = null;
    $('plView').hidden = true;
  }

  // 一覧の1行分。status：ok（再生できる）/ novideo（動画が見つからない）/ noscene（元のシーンがない）
  function plEntries() {
    const pl = state.pl;
    return pl.playlist.items.map(it => {
      const log = pl.logs.get(it.logId);
      const scene = log && log.scenes.find(s => s.id === it.sceneId);
      const info = pl.videos.get(it.logId);
      return { key: plKey(it), it, log, scene, info, status: !scene ? 'noscene' : info ? 'ok' : 'novideo' };
    });
  }
  function plEntry(key) { return key ? plEntries().find(e => e.key === key) : null; }

  // key の次（dir=1）か前（dir=-1）の、再生できる行。key がなければ最初から
  function plNeighbor(key, dir) {
    const list = plEntries();
    let i = key ? list.findIndex(e => e.key === key) : (dir > 0 ? -1 : list.length);
    for (i += dir; i >= 0 && i < list.length; i += dir) if (list[i].status === 'ok') return list[i].key;
    return null;
  }

  function renderPlaylistView() {
    const pl = state.pl;
    const list = plEntries();
    const total = list.reduce((sum, e) => sum + (e.scene ? e.scene.end - e.scene.start : 0), 0);
    $('plTitle').textContent = pl.playlist.name || 'プレイリスト';
    $('plCount').textContent = `${list.length}本 · ${C.formatTimeShort(total)}`;
    $('plExport').disabled = !list.some(e => e.status === 'ok');
    const box = $('plRows');
    const keepScroll = box.scrollTop;
    box.replaceChildren();
    list.forEach((e, i) => box.append(plRow(e, i)));
    if (!list.length) box.append(h('div', { class: 'list-empty' }, 'まだシーンが入っていません。作業画面のタグ一覧でシーンにチェックを入れ、「プレイリストに追加」で入れます。'));
    box.scrollTop = keepScroll;
  }

  function plRow(e, i) {
    const pl = state.pl;
    const playing = pl.current === e.key;
    const row = h('div', {
      class: `row pl-row${pl.selected === e.key ? ' selected' : ''}${playing ? ' playing' : ''}${e.status !== 'ok' ? ' missing' : ''}`,
      role: 'listitem', draggable: 'true', dataset: { key: e.key }
    });
    const log = e.log;
    const title = e.scene ? C.sceneTitle(e.scene, log, state.settings, log.shortcutNames) : '';
    row.style.setProperty('--team', teamVar(e.scene ? C.sceneTeam(e.scene, state.settings, log.shortcutNames) : null));
    const gameName = log ? (log.gameName || baseName(log.video.fileName)) : '';
    row.append(
      h('span', { class: 'team-bar' }),
      h('span', { class: 'handle', title: 'ドラッグで並べ替え' }, icon('i-drag')),
      h('span', { class: 'num' }, playing ? '▶' : String(i + 1)),
      h('span', { class: 'cell game', title: gameName }, gameName),
      h('span', { class: 'cell times' }, e.scene ? [C.formatTimeShort(e.scene.start), h('span', { class: 'arrow' }, '→'), C.formatTimeShort(e.scene.end)] : null),
      h('span', { class: 'cell title' }, e.scene ? (title || 'タイトルなし') : '元のシーンがありません'),
      h('span', { class: 'cell tags' }, e.status === 'novideo' ? h('span', { class: 'note' }, '動画が見つかりません')
        : e.scene ? e.scene.tags.map(id => h('span', { class: 'chip' }, C.resolveShortcut(id, state.settings, log.shortcutNames).name)) : null),
      h('button', { class: 'icon-btn pl-remove', title: 'プレイリストから外す', 'aria-label': 'プレイリストから外す', onClick: ev => { ev.stopPropagation(); plRemove(e.key); } }, icon('i-x')));
    row.addEventListener('click', () => {
      plSelect(e.key);
      if (e.status === 'ok') plPlay(e.key);
      else if (e.status === 'novideo') plLocate(e.it.logId, e.key);
    });
    row.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/x-moment-pl', e.key); ev.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes('text/x-moment-pl')) { ev.preventDefault(); row.classList.add('drop-before'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', ev => {
      const from = ev.dataTransfer.getData('text/x-moment-pl');
      if (!from) return;
      ev.preventDefault();
      ev.stopPropagation();
      plMove(from, e.key);
    });
    return row;
  }

  function plSelect(key) {
    state.pl.selected = key;
    for (const el of $('plRows').querySelectorAll('.pl-row')) el.classList.toggle('selected', el.dataset.key === key);
  }

  function plSave() {
    api.savePlaylist(state.pl.playlist).then(r => { if (!r || !r.ok) toast('プレイリストを保存できませんでした'); });
  }

  // from の行を、before の行の前へ動かす
  function plMove(from, before) {
    const items = state.pl.playlist.items;
    const i = items.findIndex(it => plKey(it) === from);
    const j = items.findIndex(it => plKey(it) === before);
    if (i < 0 || j < 0 || i === j) { renderPlaylistView(); return; }
    const [it] = items.splice(i, 1);
    items.splice(i < j ? j - 1 : j, 0, it);
    plSave();
    renderPlaylistView();
  }

  function plRemove(key) {
    const pl = state.pl;
    const i = pl.playlist.items.findIndex(it => plKey(it) === key);
    if (i < 0) return;
    pl.playlist.items.splice(i, 1);
    if (pl.current === key) { $('plVideo').pause(); pl.current = null; }
    if (pl.selected === key) pl.selected = null;
    plSave();
    renderPlaylistView();
  }

  // 見つからない動画を選んでもらう（「再開する」と同じ決まり）。見つかったら作業ログの動画の場所も新しくする
  async function plLocate(logId, key) {
    const log = state.pl.logs.get(logId);
    if (!log) return;
    const info = await findVideo(log);
    if (!info || !state.pl || state.pl.logs.get(logId) !== log) return;
    log.video.lastPath = info.path;
    log.video.fileName = info.fileName;
    const r = await api.saveLog(log);
    if (!r || !r.ok) toast('作業ログを保存できませんでした');
    state.pl.videos.set(logId, info);
    renderPlaylistView();
    plPlay(key);
  }

  // そのシーンを開始から再生する。動画が違えば入れ替え、読み込めたら（loadedmetadata）開始へ飛ぶ
  function plPlay(key) {
    const pl = state.pl;
    const e = plEntry(key);
    if (!e || e.status !== 'ok') return;
    pl.current = key;
    const v = $('plVideo');
    if (pl.url !== e.info.url) {
      pl.url = e.info.url;
      pl.loading = true;
      v.src = e.info.url;
    } else {
      pl.loading = false;
      v.currentTime = e.scene.start;
      v.play().catch(() => {});
    }
    renderPlaylistView();
    const el = $('plRows').querySelector(`.pl-row[data-key="${CSS.escape(key)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // 次の再生できるシーンへ。なければ止まる
  function plAdvance() {
    const next = plNeighbor(state.pl.current, 1);
    if (next) plPlay(next); else $('plVideo').pause();
  }

  function plTogglePlay() {
    const pl = state.pl;
    const v = $('plVideo');
    if (!v.paused && !v.ended) { v.pause(); return; }
    const e = plEntry(pl.current);
    if (e && e.status === 'ok' && !pl.loading && v.currentTime >= e.scene.start - 0.5 && v.currentTime < e.scene.end - 0.05) { v.play().catch(() => {}); return; }
    const sel = plEntry(pl.selected);
    const from = sel && sel.status === 'ok' ? sel.key : plNeighbor(null, 1);
    if (from) plPlay(from);
  }

  function plStep(dir) {
    const pl = state.pl;
    const to = plNeighbor(pl.current, dir);
    if (to) plPlay(to);
    else if (pl.current) plPlay(pl.current);
  }

  // シーンの開始から終了の間で動かす
  function plSeekTo(t) {
    const e = plEntry(state.pl.current);
    if (!e || e.status !== 'ok' || state.pl.loading) return;
    $('plVideo').currentTime = Math.max(e.scene.start, Math.min(e.scene.end, t));
  }

  function plTick() {
    const pl = state.pl;
    const v = $('plVideo');
    const e = plEntry(pl.current);
    if (e && e.status === 'ok' && !pl.loading && !v.paused && v.currentTime >= e.scene.end) plAdvance();
    updatePlBar();
  }

  function updatePlBar() {
    const pl = state.pl;
    const v = $('plVideo');
    const list = plEntries();
    const i = list.findIndex(e => e.key === pl.current);
    const e = i >= 0 && list[i].status === 'ok' ? list[i] : null;
    const len = e ? e.scene.end - e.scene.start : 0;
    const t = e && !pl.loading ? Math.max(0, Math.min(len, v.currentTime - e.scene.start)) : 0;
    $('plClock').textContent = `${C.formatTime(t)} / ${C.formatTime(len)}`;
    const pct = len ? (t / len) * 100 : 0;
    $('plSeekFill').style.width = `${pct}%`;
    $('plSeekThumb').style.left = `${pct}%`;
    $('plPos').textContent = i >= 0 ? `${i + 1} / ${list.length}` : `– / ${list.length}`;
    setPlayIcon($('plPlay'), !v.paused && !v.ended);
  }

  // ---------- ダウンロード ----------
  function openExportSheet() {
    if (state.view === 'playlist') { openPlaylistExportSheet(); return; }
    if (state.view !== 'work' || !state.game) return;
    const g = state.game;
    const items = g.scenes.filter(s => state.checked.has(s.id))
      .map(s => ({ id: s.id, title: C.sceneTitle(s, g, state.settings, g.shortcutNames), start: s.start, end: s.end }));
    if (!items.length) { toast('ダウンロードするシーンにチェックを入れてください'); return; }
    const titles = [...new Set(items.map(i => i.title))];
    showExportSheet({
      items,
      folder: g.gameName || 'Moment',
      mergedTitle: titles.length === 1 && titles[0] ? titles[0] : `${g.gameName} まとめ`,
      notes: [],
      // 別々のときのファイル名（試合の時刻順）
      fileNames: () => { const m = C.planFileNames(items); return [...items].sort((a, b) => a.start - b.start).map(i => m.get(i.id)); },
      start: st => api.startExport({
        input: state.video.path, dest: st.dest, gameName: g.gameName, quality: st.quality, mode: st.mode, mergedTitle: st.mergedTitle, items: st.items
      })
    });
  }

  // プレイリストのダウンロード：再生できるシーン全部を、プレイリストの順に
  function openPlaylistExportSheet() {
    if (!state.pl) return;
    const pl = state.pl.playlist;
    const list = plEntries();
    const ok = list.filter(e => e.status === 'ok');
    if (!ok.length) return;
    const items = ok.map(e => ({ id: e.key, input: e.info.path, title: C.sceneTitle(e.scene, e.log, state.settings, e.log.shortcutNames), start: e.scene.start, end: e.scene.end }));
    const novideo = list.filter(e => e.status === 'novideo').length;
    const noscene = list.filter(e => e.status === 'noscene').length;
    const name = pl.name || 'プレイリスト';
    showExportSheet({
      items,
      folder: name,
      mergedTitle: name,
      notes: [novideo ? `動画が見つからない${novideo}本は入りません。` : null, noscene ? `元のシーンがない${noscene}本は入りません。` : null].filter(Boolean),
      fileNames: () => { const m = C.playlistFileNames(items); return items.map(i => m.get(i.id)); },
      start: st => api.startPlaylistExport({ dest: st.dest, name, quality: st.quality, mode: st.mode, mergedTitle: st.mergedTitle, items: st.items })
    });
  }

  // 確認画面を出す。src：{items, folder, mergedTitle, notes, fileNames(), start(st)}
  function showExportSheet(src) {
    const st = {
      ...src, phase: 'confirm', mode: 'separate',
      dest: state.settings.exportDir, quality: state.settings.exportQuality,
      progress: 0, done: 0, current: '', result: null
    };
    state.sheet = { kind: 'export', st };
    $('sheet').hidden = false;
    renderExportSheet();
  }

  function renderExportSheet() {
    const st = state.sheet.st;
    const body = $('sheetBody');
    body.className = 'sheet';
    body.replaceChildren();
    const n = st.items.length;
    if (st.phase === 'confirm') {
      const names = st.mode === 'merged' ? [`${C.sanitizeFileName(st.mergedTitle || 'まとめ')}.mp4`] : st.fileNames();
      const folder = C.sanitizeFileName(st.folder);
      const shown = names.slice(0, 4);
      const destText = h('span', { class: 'path', title: st.dest || '' }, st.dest ? shortPath(st.dest) : '未選択');
      const mergedTitle = h('input', { class: 'field', value: st.mergedTitle, style: 'width:100%;margin-top:10px', 'aria-label': '結合したファイルのタイトル', onInput: e => { st.mergedTitle = e.target.value; preview.replaceChildren(...previewLines()); } });
      const previewLines = () => {
        const ns = st.mode === 'merged' ? [`${C.sanitizeFileName(st.mergedTitle || 'まとめ')}.mp4`] : shown;
        return [h('b', {}, `${folder}/`), h('br'), ...ns.flatMap(x => ['　', x, h('br')]), st.mode !== 'merged' && names.length > shown.length ? `　ほか ${names.length - shown.length}本` : null];
      };
      const preview = h('div', { class: 'names' }, ...previewLines());
      const mode = (val, label) => h('label', {}, h('input', { type: 'radio', name: 'xm', checked: st.mode === val, onChange: () => { st.mode = val; renderExportSheet(); } }), label);
      body.append(
        h('h2', {}, 'ダウンロード'),
        h('p', { class: 'sub' }, `${n}本のシーンを動画ファイルにします。開始から終了まで、ずれなく切り出します。`, ...st.notes.map(t => [h('br'), t])),
        h('div', { class: 'section' }, h('div', { class: 'section-title' }, '書き方'),
          h('div', { class: 'radio-row' }, mode('separate', 'シーンごとに別々のファイル'), mode('merged', '1本に結合')),
          st.mode === 'merged' ? mergedTitle : null),
        h('div', { class: 'section' }, h('div', { class: 'section-title' }, '保存先'),
          h('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:space-between' }, destText,
            h('button', { class: 'btn small', onClick: async () => { const d = await api.chooseFolder(st.dest); if (d) { st.dest = d; destText.textContent = shortPath(d); destText.title = d; } } }, '変更')),
          preview),
        h('div', { class: 'section' }, h('div', { class: 'section-title' }, '画質'),
          h('select', { class: 'field', onChange: e => { st.quality = e.target.value; } },
            ...[['source', '元の解像度'], ['1080p', '1080p'], ['720p', '720p']].map(([v, t]) => h('option', { value: v, selected: st.quality === v }, t)))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onClick: () => closeSheet() }, 'キャンセル'),
          h('button', { class: 'btn primary', id: 'exportGo', onClick: runExport }, st.mode === 'merged' ? '1本に結合してダウンロード' : `${n}本をダウンロード`)));
      return;
    }
    if (st.phase === 'running') {
      body.append(
        h('h2', {}, 'ダウンロード中'),
        h('p', { class: 'sub', id: 'xCur' }, '準備しています…'),
        h('div', { class: 'progress' }, h('div', { id: 'xBar' })),
        h('div', { class: 'progress-line' }, h('span', { id: 'xPct' }, '0%'), h('span', { id: 'xCount' })),
        h('div', { class: 'actions' }, h('button', { class: 'btn', id: 'xCancel', onClick: () => api.cancelJob() }, '中止')));
      updateExportProgress();
      return;
    }
    const r = st.result;
    const results = (r && r.results) || [];
    const ok = results.filter(x => x.ok).length;
    const bad = results.filter(x => !x.ok);
    const headline = !r || !r.ok ? 'ダウンロードできませんでした'
      : r.cancelled ? `中止しました（${ok}本は保存済み）`
        : bad.length ? `${ok}本をダウンロードしました。${bad.length}本は失敗しました`
          : st.mode === 'merged' ? '1本に結合してダウンロードしました' : `${ok}本をダウンロードしました`;
    body.append(
      h('h2', {}, headline),
      r && r.dir ? h('p', { class: 'sub path', style: 'max-width:100%', title: r.dir }, shortPath(r.dir, 72)) : (r && r.reason ? h('p', { class: 'sub' }, r.reason) : null),
      results.length ? h('div', { class: 'results' }, ...results.map(x => h('div', { class: `result${x.ok ? '' : ' bad'}` },
        h('span', { class: 'mark' }, x.ok ? '保存' : '失敗'),
        h('span', {}, x.file, x.ok ? null : h('span', { class: 'why' }, `　${x.reason}`))))) : null,
      h('div', { class: 'actions' },
        r && r.dir && ok > 0 ? h('button', { class: 'btn', onClick: () => api.openFolder(r.dir) }, `${FOLDER_APP}で表示`) : null,
        h('button', { class: 'btn primary', onClick: () => closeSheet() }, '閉じる')));
  }

  function updateExportProgress() {
    const st = state.sheet && state.sheet.st;
    if (!st || !$('xBar')) return;
    const pct = Math.round(st.progress * 100);
    $('xBar').style.width = `${pct}%`;
    $('xPct').textContent = `${pct}%`;
    $('xCur').textContent = st.current || '準備しています…';
    $('xCount').textContent = st.mode === 'merged' ? '' : `${Math.min(st.done, st.items.length)} / ${st.items.length}`;
  }

  async function runExport() {
    const st = state.sheet.st;
    if (!st.dest) {
      const d = await api.chooseFolder(state.settings.exportDir);
      if (!d) return;
      st.dest = d;
    }
    state.settings.exportDir = st.dest;
    state.settings.exportQuality = st.quality;
    saveSettings();
    st.phase = 'running';
    renderExportSheet();
    const off = api.on('job:event', ev => {
      if (ev.type !== 'progress') return;
      st.progress = ev.fraction || 0;
      if (ev.current) st.current = ev.current;
      if (typeof ev.done === 'number') st.done = ev.done;
      if (state.sheet && state.sheet.st === st && st.phase === 'running') updateExportProgress();
    });
    const v = video();
    if (!v.paused) v.pause();
    const result = await st.start(st);
    off();
    st.result = result;
    st.phase = 'done';
    if (state.sheet && state.sheet.st === st) renderExportSheet();
  }

  function openSettingsSheet() {
    state.sheet = { kind: 'settings' };
    const body = $('sheetBody');
    body.className = 'sheet wide';
    const content = h('div');
    body.replaceChildren(
      h('div', { class: 'pane-head' }, h('h2', {}, '設定'), h('button', { class: 'btn', onClick: () => closeSheet() }, '閉じる')),
      content);
    renderSettings(content);
    $('sheet').hidden = false;
  }

  function closeSheet(force) {
    if (!state.sheet) return;
    if (!force && state.sheet.kind === 'export' && state.sheet.st.phase === 'running') return;
    endCapture();
    const kind = state.sheet.kind;
    state.sheet = null;
    $('sheet').hidden = true;
    $('sheetBody').replaceChildren();
    if (kind === 'settings') rerenderRows();
    else if (state.view === 'work') renderRows();
  }

  // ---------- キー操作 ----------
  function onKeyDown(e) {
    if (state.capture) { handleCapture(e); return; }
    if (e.isComposing || e.keyCode === 229) return;
    if (isTyping(e.target)) return;
    if (e.key === 'Escape' && !$('popover').hidden) { closePopover(); e.preventDefault(); return; }
    if (state.sheet) {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
      return;
    }
    if (state.view !== 'work' && state.view !== 'playlist') return;

    const ae = document.activeElement;
    if (ae && ae !== document.body && (ae.tagName === 'BUTTON' || (ae.tagName === 'INPUT' && !isTyping(ae)))) ae.blur();

    const combo = C.comboFromEvent(e);
    const b = state.settings.baseKeys;
    const is = id => C.sameCombo(b[id], combo);

    if (is('toggleKeys') && !b.toggleKeys.meta) { e.preventDefault(); api.toggleKeys(); return; }
    if (combo.meta) return; // ⌘ の付くものはメニューに任せる
    if (state.view === 'playlist') { plKeyDown(e, combo, is); return; }
    if ((e.code === 'Delete' || e.code === 'Backspace') && !combo.shift && !combo.alt) {
      if (state.selectedId) { e.preventDefault(); deleteSelected(); }
      return;
    }
    if (e.code === 'Escape') { if (state.selectedId) select(null); return; }

    if (is('start')) { e.preventDefault(); if (!e.repeat) startRecording(); return; }
    if (is('end')) { e.preventDefault(); if (!e.repeat) endRecording(); return; }
    if (is('cancel')) { e.preventDefault(); cancelRecording(); return; }
    if (is('playPause')) { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
    if (is('back')) { e.preventDefault(); seekBy(-C.SEEK_STEP); return; }
    if (is('forward')) { e.preventDefault(); seekBy(C.SEEK_STEP); return; }
    if (is('slower')) { e.preventDefault(); if (!e.repeat) setSpeed(state.speedIndex - 1); return; }
    if (is('faster')) { e.preventDefault(); if (!e.repeat) setSpeed(state.speedIndex + 1); return; }

    const sc = state.settings.shortcuts.find(s => s.key && s.key.code && C.sameCombo(s.key, combo));
    if (sc) { e.preventDefault(); if (!e.repeat) applyShortcut(sc); }
  }

  // プレイリスト画面のキー。再生は作業画面と同じキーで、記録とショートカットは働かない
  function plKeyDown(e, combo, is) {
    const pl = state.pl;
    if ((e.code === 'Delete' || e.code === 'Backspace') && !combo.shift && !combo.alt) {
      if (pl.selected) { e.preventDefault(); plRemove(pl.selected); }
      return;
    }
    if (e.code === 'Escape') { if (pl.selected) plSelect(null); return; }
    if (is('playPause')) { e.preventDefault(); if (!e.repeat) plTogglePlay(); return; }
    if (is('back')) { e.preventDefault(); plSeekTo($('plVideo').currentTime - C.SEEK_STEP); return; }
    if (is('forward')) { e.preventDefault(); plSeekTo($('plVideo').currentTime + C.SEEK_STEP); return; }
    if (is('slower')) { e.preventDefault(); if (!e.repeat) setSpeed(state.speedIndex - 1); return; }
    if (is('faster')) { e.preventDefault(); if (!e.repeat) setSpeed(state.speedIndex + 1); }
  }

  // ---------- つなぎこみ ----------
  function bind() {
    window.addEventListener('keydown', onKeyDown, true);
    for (const btn of document.querySelectorAll('.rail-item')) {
      btn.addEventListener('click', () => {
        const p = btn.dataset.pane;
        if (p === 'new') state.newFlow = null;
        selectPane(p);
      });
    }
    $('importLog').addEventListener('click', importLog);
    $('newPlaylist').addEventListener('click', () => { state.plNew = true; renderPlaylists(); });

    const v = $('video');
    v.addEventListener('loadedmetadata', () => {
      if (!state.game) return;
      state.game.video.duration = v.duration;
      const pos = Math.min(state.game.lastPosition || 0, v.duration || 0);
      if (pos > 0) v.currentTime = pos;
      updateBar();
    });
    v.addEventListener('error', () => {
      if (state.view !== 'work' || !v.getAttribute('src')) return;
      toast('この形式の動画は開けません');
      closeWork('logs');
    });
    v.addEventListener('pause', () => { if (state.game) saveSoon(); });
    v.addEventListener('seeked', () => { if (state.game && v.paused) saveSoon(); });
    setInterval(() => { if (state.game && !v.paused) saveSoon(); }, 15000);

    $('toLog').addEventListener('click', () => closeWork('logs'));
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnBack').addEventListener('click', () => seekBy(-C.SEEK_STEP));
    $('btnFwd').addEventListener('click', () => seekBy(C.SEEK_STEP));
    $('btnSpeed').addEventListener('click', e => { e.stopPropagation(); if (!$('popover').hidden) closePopover(); else openSpeedPopover(); });
    $('btnKeys').addEventListener('click', () => api.toggleKeys());

    const seek = $('seek');
    const seekTo = x => {
      const r = seek.getBoundingClientRect();
      const d = v.duration;
      if (!Number.isFinite(d)) return;
      state.stopAt = null;
      v.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
      updateBar();
    };
    seek.addEventListener('pointerdown', e => { seek.setPointerCapture(e.pointerId); seekTo(e.clientX); });
    seek.addEventListener('pointermove', e => { if (seek.hasPointerCapture(e.pointerId)) seekTo(e.clientX); });

    const bindSplitter = (split, w) => split.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const bar = w.querySelector('.bar');
      // つかんだ位置と境目のずれ。これを保ったまま動かすので、つかんだ瞬間に跳ねない
      const grab = bar.getBoundingClientRect().top - e.clientY;
      let done = false;
      const move = ev => {
        const wr = w.getBoundingClientRect();
        const barH = bar.offsetHeight;
        const avail = wr.height - barH;
        const want = wr.bottom - (ev.clientY + grab) - barH;
        const listH = listHeightFor(avail, want / avail);
        w.style.setProperty('--list-h', `${listH}px`);
        state.settings.listRatio = Math.round((listH / avail) * 1000) / 1000;
      };
      const end = () => {
        if (done) return;
        done = true;
        document.body.classList.remove('resizing');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', end);
        split.removeEventListener('pointercancel', end);
        split.removeEventListener('lostpointercapture', end);
        saveSettings();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', end);
      split.addEventListener('pointercancel', end);
      split.addEventListener('lostpointercapture', end);
    });
    bindSplitter($('splitter'), $('work'));
    bindSplitter($('plSplitter'), $('plView'));
    window.addEventListener('resize', layoutList);

    $('sortSel').addEventListener('change', e => { state.sort = e.target.value; e.target.blur(); renderRows(); });
    $('filterSel').addEventListener('change', e => { state.filter = e.target.value; e.target.blur(); renderRows(); });
    $('memoSearch').addEventListener('input', e => { state.memoQuery = e.target.value; renderRows(); });
    $('memoSearch').addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.isComposing)) e.target.blur(); });
    $('checkAll').addEventListener('change', e => {
      const ids = visibleRows().map(r => r.id);
      for (const id of ids) { if (e.target.checked) state.checked.add(id); else state.checked.delete(id); }
      e.target.blur();
      renderRows();
    });
    $('btnExport').addEventListener('click', openExportSheet);
    $('btnAddToPl').addEventListener('click', e => { e.stopPropagation(); if (!$('popover').hidden) closePopover(); else openAddToPlaylist(); });
    $('rows').addEventListener('click', e => { if (e.target === $('rows')) select(null); });

    // プレイリスト画面
    const plv = $('plVideo');
    plv.addEventListener('loadedmetadata', () => {
      const pl = state.pl;
      if (!pl || !pl.loading) return;
      pl.loading = false;
      const e = plEntry(pl.current);
      if (!e || e.status !== 'ok') return;
      plv.currentTime = e.scene.start;
      plv.play().catch(() => {});
    });
    plv.addEventListener('ended', () => { if (state.pl && !state.pl.loading && state.pl.current) plAdvance(); });
    // 開けない動画は「動画が見つかりません」と同じ扱いにして飛ばす（行をクリックすると選び直せる）
    plv.addEventListener('error', () => {
      const pl = state.pl;
      if (state.view !== 'playlist' || !pl || !plv.getAttribute('src')) return;
      toast('この形式の動画は開けません');
      const e = plEntry(pl.current);
      pl.loading = false;
      pl.url = null;
      if (!e) return;
      pl.videos.set(e.it.logId, null);
      const next = plNeighbor(e.key, 1);
      pl.current = null;
      renderPlaylistView();
      if (next) plPlay(next);
    });
    $('plBack').addEventListener('click', () => showLauncher('playlists'));
    $('plPlay').addEventListener('click', plTogglePlay);
    $('plPrev').addEventListener('click', () => plStep(-1));
    $('plNext').addEventListener('click', () => plStep(1));
    $('plSpeed').addEventListener('click', e => { e.stopPropagation(); if (!$('popover').hidden) closePopover(); else openSpeedPopover(); });
    $('plExport').addEventListener('click', openPlaylistExportSheet);
    $('plRows').addEventListener('click', e => { if (e.target === $('plRows')) plSelect(null); });
    const plSeek = $('plSeek');
    const plSeekAt = x => {
      const e = plEntry(state.pl && state.pl.current);
      if (!e || e.status !== 'ok') return;
      const r = plSeek.getBoundingClientRect();
      plSeekTo(e.scene.start + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (e.scene.end - e.scene.start));
    };
    plSeek.addEventListener('pointerdown', e => { plSeek.setPointerCapture(e.pointerId); plSeekAt(e.clientX); });
    plSeek.addEventListener('pointermove', e => { if (plSeek.hasPointerCapture(e.pointerId)) plSeekAt(e.clientX); });

    document.addEventListener('click', e => { if (!$('popover').hidden && !e.target.closest('#popover')) closePopover(); });
    $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });

    // ドラッグ＆ドロップ
    document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', e => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      if (state.view === 'launcher' && state.pane === 'merge') { addMergeFiles(paths); return; }
      if (state.view === 'launcher') { state.newFlow = null; startNewWith(paths[0]); }
    });

    // メニュー
    api.on('menu:new', async () => { if (state.view !== 'launcher') await closeWork('new'); state.newFlow = null; selectPane('new'); pickNewVideo(); });
    api.on('menu:merge', async () => { if (state.view !== 'launcher') await closeWork('merge'); else selectPane('merge'); });
    api.on('menu:log', () => closeWork('logs'));
    api.on('menu:settings', () => { if (state.view !== 'launcher') openSettingsSheet(); else selectPane('settings'); });
    api.on('menu:export', () => openExportSheet());
    api.on('menu:import', importLog);
    api.on('menu:undo', () => { if (isTyping(document.activeElement)) document.execCommand('undo'); else if (!state.sheet) undo(); });
    api.on('menu:redo', () => { if (isTyping(document.activeElement)) document.execCommand('redo'); else if (!state.sheet) redo(); });
    api.on('keys:visible', on => { state.keysVisible = !!on; $('btnKeys').setAttribute('aria-pressed', on ? 'true' : 'false'); });
    api.on('app:flush', async () => { await saveNow(); api.flushed(); });
  }

  async function init() {
    state.settings = await api.getSettings();
    bind();
    showLauncher('logs');
    pushKeyData();
    requestAnimationFrame(tick);
  }

  // テスト用に状態を見られるようにする（画面の動きには使わない）
  window.__moment = { state, C };
  init();
})();
