// Moment の中心になる決まりごと（時刻、タイトル、ファイル名、キー）。
// 画面（renderer）からもテスト（node）からも同じものを使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MomentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.2, 1.5, 2];
  const SEEK_STEP = 3;

  // ---------- 時刻 ----------
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const t = Math.floor(sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
  }

  // "52:39" / "1:02:15" / "75" → 秒。読めなければ null
  function parseTime(text) {
    const str = String(text || '').trim().replace(/[：]/g, ':').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (!/^\d+(:\d{1,2}){0,2}$/.test(str)) return null;
    const parts = str.split(':').map(Number);
    if (parts.length > 1 && parts.slice(1).some(p => p >= 60)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  // ---------- チームとタイトル ----------
  function teamName(game, team) {
    if (team === 'A') return (game && game.teamA && game.teamA.trim()) || 'チームA';
    if (team === 'B') return (game && game.teamB && game.teamB.trim()) || 'チームB';
    return '';
  }

  // シーンのタグ（ショートカットの内部番号）から、名前とチームを引く。
  // 今の設定 → 削除済みの設定 → 作業ログに残した控え、の順に探す。
  function resolveShortcut(id, settings, snapshot) {
    const live = settings && settings.shortcuts && settings.shortcuts.find(s => s.id === id);
    if (live) return live;
    const gone = settings && settings.deletedShortcuts && settings.deletedShortcuts.find(s => s.id === id);
    if (gone) return gone;
    if (snapshot && snapshot[id]) return { id, name: snapshot[id].name, team: snapshot[id].team || null };
    return { id, name: '?', team: null };
  }

  function tagPiece(sc, game) {
    const t = teamName(game, sc.team);
    return t ? `${t} ${sc.name}` : sc.name;
  }

  function autoTitle(tags, game, settings, snapshot) {
    return (tags || []).map(id => tagPiece(resolveShortcut(id, settings, snapshot), game)).join(' ');
  }

  function sceneTitle(scene, game, settings, snapshot) {
    if (scene.titleOverride != null && scene.titleOverride !== '') return scene.titleOverride;
    return autoTitle(scene.tags, game, settings, snapshot);
  }

  // シーンのチーム = 最初に押したチーム付きショートカットのチーム
  function sceneTeam(scene, settings, snapshot) {
    for (const id of scene.tags || []) {
      const sc = resolveShortcut(id, settings, snapshot);
      if (sc.team === 'A' || sc.team === 'B') return sc.team;
    }
    return null;
  }

  // ---------- ファイル名 ----------
  function sanitizeFileName(name) {
    let s = String(name || '')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[:/\\]/g, '-')
      .replace(/[*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    if (!s) s = 'タイトルなし';
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s;
  }

  // 保存先によって同じファイル名とみなされる違い（大文字・小文字、Unicode の正規化）をそろえた、比べるための名前
  function fileNameKey(name) {
    return String(name || '').normalize('NFC').toLowerCase().normalize('NFC');
  }

  // 同じタイトルの中で試合の時刻順に番号を振る。100本以上なら3桁。
  // 大文字・小文字や Unicode の正規化だけが違うタイトルは、同じタイトルとして続きの番号にする（同じファイル名になるのを防ぐ）。
  // items: [{id, title, start}] → Map(id → "タイトル 01.mp4")
  function planFileNames(items, ext) {
    const extension = ext || '.mp4';
    const groups = new Map();
    for (const it of items) {
      const base = sanitizeFileName(it.title || 'タイトルなし');
      const key = fileNameKey(base);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ it, base });
    }
    const out = new Map();
    for (const list of groups.values()) {
      list.sort((a, b) => a.it.start - b.it.start || String(a.it.id).localeCompare(String(b.it.id)));
      const width = list.length >= 100 ? 3 : 2;
      list.forEach(({ it, base }, i) => out.set(it.id, `${base} ${String(i + 1).padStart(width, '0')}${extension}`));
    }
    return out;
  }

  // ---------- キー ----------
  const CODE_LABELS = {
    Comma: '、', Period: '。', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc',
    Backspace: '⌫', Delete: 'Delete', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Minus: '-', Equal: '^', Slash: '/', Semicolon: ';', Quote: ':', BracketLeft: '@', BracketRight: '[',
    Backslash: ']', IntlYen: '¥', IntlRo: 'ろ', Backquote: '半/全', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown'
  };

  function codeLabel(code) {
    if (!code) return '';
    if (CODE_LABELS[code]) return CODE_LABELS[code];
    let m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return `テンキー${m[1]}`;
    m = /^F(\d{1,2})$/.exec(code); if (m) return code;
    return code;
  }

  function keyLabel(combo, platform) {
    if (!combo || !combo.code) return '未設定';
    const mac = platform !== 'win32' && platform !== 'linux';
    const parts = [];
    if (combo.meta) parts.push(mac ? '⌘' : 'Ctrl+');
    if (combo.alt) parts.push(mac ? '⌥' : 'Alt+');
    if (combo.shift) parts.push(mac ? '⇧' : 'Shift+');
    return parts.join('') + codeLabel(combo.code);
  }

  function comboFromEvent(e) {
    return { code: e.code, shift: !!e.shiftKey, meta: !!(e.metaKey || e.ctrlKey), alt: !!e.altKey };
  }

  function sameCombo(a, b) {
    return !!a && !!b && a.code === b.code && !!a.shift === !!b.shift && !!a.meta === !!b.meta && !!a.alt === !!b.alt;
  }

  const MODIFIER_CODES = ['ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'CapsLock', 'Fn', 'FnLock'];
  const RESERVED_CODES = ['Escape', 'Tab', 'Enter', 'NumpadEnter', 'Backspace', 'Delete'];

  const BASE_ACTIONS = [
    { id: 'start', label: '記録を開始' },
    { id: 'end', label: '記録を終了' },
    { id: 'cancel', label: '記録を取り消す' },
    { id: 'playPause', label: '再生 / 停止' },
    { id: 'back', label: '3秒戻る' },
    { id: 'forward', label: '3秒進む' },
    { id: 'slower', label: '速度を下げる' },
    { id: 'faster', label: '速度を上げる' },
    { id: 'toggleKeys', label: 'キー表示の表示 / 非表示' }
  ];

  // 割り当てられるか調べる。だめなら理由の文言を返す。
  // owner: {kind:'base', id} または {kind:'shortcut', id}
  function keyProblem(combo, settings, owner) {
    if (!combo || !combo.code || MODIFIER_CODES.includes(combo.code)) return 'キーを押してください';
    if (RESERVED_CODES.includes(combo.code)) return 'このキーは使えません';
    const isToggle = owner && owner.kind === 'base' && owner.id === 'toggleKeys';
    if (!isToggle && (combo.meta || combo.alt)) return '⌘・Ctrl・Option との組み合わせは使えません';
    for (const a of BASE_ACTIONS) {
      if (owner && owner.kind === 'base' && owner.id === a.id) continue;
      if (sameCombo(settings.baseKeys[a.id], combo)) return `「${a.label}」で使っています`;
    }
    for (const s of settings.shortcuts) {
      if (owner && owner.kind === 'shortcut' && owner.id === s.id) continue;
      if (sameCombo(s.key, combo)) return `「${s.name}」で使っています`;
    }
    return null;
  }

  // ---------- 初期設定 ----------
  function defaultSettings() {
    const sc = (id, team, name, code, shift) => ({ id, team, name, key: { code, shift: !!shift, meta: false, alt: false } });
    return {
      version: 1,
      shortcuts: [
        sc('a-setof', 'A', 'setOF', 'Digit1'),
        sc('a-fb', 'A', 'FB', 'Digit2'),
        sc('a-pt', 'A', 'PT', 'Digit3'),
        sc('b-setof', 'B', 'setOF', 'Digit8'),
        sc('b-fb', 'B', 'FB', 'Digit9'),
        sc('b-pt', 'B', 'PT', 'Digit0'),
        sc('n-65', null, '6:5', 'KeyW'),
        sc('n-56', null, '5:6', 'KeyE'),
        sc('n-76', null, '7:6', 'KeyR'),
        sc('n-67', null, '6:7', 'KeyT')
      ],
      deletedShortcuts: [],
      baseKeys: {
        start: { code: 'Comma', shift: false, meta: false, alt: false },
        end: { code: 'Period', shift: false, meta: false, alt: false },
        cancel: { code: 'F1', shift: false, meta: false, alt: false },
        playPause: { code: 'Space', shift: false, meta: false, alt: false },
        back: { code: 'ArrowLeft', shift: false, meta: false, alt: false },
        forward: { code: 'ArrowRight', shift: false, meta: false, alt: false },
        slower: { code: 'ArrowDown', shift: false, meta: false, alt: false },
        faster: { code: 'ArrowUp', shift: false, meta: false, alt: false },
        toggleKeys: { code: 'KeyK', shift: false, meta: true, alt: false }
      },
      showShortcutsBeforeTagging: true,
      addTagMethod: 'key',
      exportQuality: 'source',
      exportDir: null,
      theme: 'system',
      listRatio: 0.32
    };
  }

  // ---------- 一覧の並び順と絞り込み ----------
  const SORTS = [
    { id: 'timeDesc', label: '時刻の新しい順' },
    { id: 'timeAsc', label: '時刻の古い順' },
    { id: 'created', label: '作った順' },
    { id: 'title', label: 'タイトル順' }
  ];

  function sortScenes(rows, sortId) {
    const list = rows.slice();
    const cmp = {
      timeDesc: (a, b) => b.start - a.start || b.seq - a.seq,
      timeAsc: (a, b) => a.start - b.start || a.seq - b.seq,
      created: (a, b) => b.seq - a.seq,
      title: (a, b) => (a.title || '').localeCompare(b.title || '', 'ja') || a.start - b.start
    }[sortId] || ((a, b) => b.start - a.start);
    return list.sort(cmp);
  }

  // filter: {kind:'all'} | {kind:'title', value} | {kind:'team', value:'A'|'B'} | {kind:'tag', value:id}
  function filterScenes(rows, filter, memoText) {
    const q = String(memoText || '').trim().toLowerCase();
    return rows.filter(r => {
      if (filter && filter.kind === 'title' && r.title !== filter.value) return false;
      if (filter && filter.kind === 'team' && r.team !== filter.value) return false;
      if (filter && filter.kind === 'tag' && !(r.tags || []).includes(filter.value)) return false;
      if (q && !String(r.memo || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // 再開するとき、指紋が違っても長さが同じ（差が1秒以内）なら同じ映像として確かめる
  function sameDuration(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && Math.abs(a - b) <= 1;
  }

  return {
    SPEEDS, SEEK_STEP, SORTS, BASE_ACTIONS,
    formatTime, parseTime, teamName, resolveShortcut, autoTitle, sceneTitle, sceneTeam,
    sanitizeFileName, fileNameKey, planFileNames, codeLabel, keyLabel, comboFromEvent, sameCombo, keyProblem,
    defaultSettings, sortScenes, filterScenes, sameDuration, MODIFIER_CODES
  };
});
