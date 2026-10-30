// 作業ログの形の決まり。ファイルから読み込んだものや画面から届いたものを確かめ、
// 確かめた項目だけで作業ログを作り直す（受け取ったものをそのまま保存しない）。
const VERSION = 1;
const LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  scenes: 10000,
  tagsPerScene: 100,
  shortcuts: 1000,
  text: 1000, // 試合名・チーム名・タイトル
  memo: 20000,
  shortcutName: 200,
  fileName: 1024,
  path: 4096,
  fingerprint: 128,
  date: 64
};
const DURATION_SLACK = 2; // 動画の長さからはみ出してよい秒数（長さが少し違う動画で再開したときのゆとり）
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// 作業ログの中身が正しくないときのエラー。message はそのまま画面に出せる理由
class LogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogError';
  }
}

function fail(message) { throw new LogError(message); }

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// 作業ログ・シーン・タグの ID。オブジェクトの鍵にも使うので、Object の組み込みの名前は受け付けない
function isId(v) { return typeof v === 'string' && ID_RE.test(v) && !(v in Object.prototype); }

function text(v, label, max, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') fail(`${label}が文字列ではありません`);
  if (v.length > max) fail(`${label}が長すぎます（${max}文字まで）`);
  return v;
}

function time(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${label}が数になっていません`);
  return v;
}

// 0以上の数。ないとき・読めない数のときは fallback
function amount(v, label, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'number') fail(`${label}が数ではありません`);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function checkVideo(v) {
  if (v == null) fail('動画の情報がありません');
  if (!isObject(v)) fail('動画の情報の形が正しくありません');
  const fingerprint = text(v.fingerprint, '動画の指紋', LIMITS.fingerprint, '');
  if (!fingerprint) fail('動画の指紋がありません');
  let duration = null;
  if (v.duration != null) {
    if (typeof v.duration !== 'number') fail('動画の長さが数ではありません');
    if (Number.isFinite(v.duration) && v.duration > 0) duration = v.duration; // 0 や読めない長さは「不明」
  }
  return {
    fingerprint,
    fileName: text(v.fileName, '動画のファイル名', LIMITS.fileName, ''),
    lastPath: text(v.lastPath, '動画の場所', LIMITS.path, null),
    size: amount(v.size, '動画の大きさ', null),
    duration
  };
}

function checkScene(s, n, duration) {
  const at = `シーン${n}`;
  if (!isObject(s)) fail(`${at}の形が正しくありません`);
  if (!isId(s.id)) fail(`${at}：ID の形が正しくありません`);
  const start = time(s.start, `${at}：開始`);
  const end = time(s.end, `${at}：終了`);
  if (start < 0) fail(`${at}：開始が0より前です`);
  if (!(end > start)) fail(`${at}：終了が開始より後になっていません`);
  if (duration != null && end > duration + DURATION_SLACK) fail(`${at}：終了が動画の長さを超えています`);
  let seq = null;
  if (s.seq != null) {
    if (!Number.isSafeInteger(s.seq) || s.seq < 1) fail(`${at}：作った順の形が正しくありません`);
    seq = s.seq;
  }
  if (s.tags != null && !Array.isArray(s.tags)) fail(`${at}：タグが配列ではありません`);
  const rawTags = s.tags || [];
  if (rawTags.length > LIMITS.tagsPerScene) fail(`${at}：タグが多すぎます（${LIMITS.tagsPerScene}個まで）`);
  const tags = [];
  for (const t of rawTags) {
    if (!isId(t)) fail(`${at}：タグの形が正しくありません`);
    if (!tags.includes(t)) tags.push(t);
  }
  return {
    id: s.id,
    seq,
    start,
    end,
    tags,
    titleOverride: text(s.titleOverride, `${at}：タイトル`, LIMITS.text, null),
    memo: text(s.memo, `${at}：メモ`, LIMITS.memo, '')
  };
}

function checkShortcutEntry(id, e, at) {
  if (!isId(id)) fail(`${at}：ID の形が正しくありません`);
  if (!isObject(e)) fail(`${at}の形が正しくありません`);
  const name = text(e.name, `${at}：名前`, LIMITS.shortcutName, null);
  if (name == null) fail(`${at}：名前がありません`);
  if (e.team != null && e.team !== 'A' && e.team !== 'B') fail(`${at}：チームは A・B・なしのどれかにしてください`);
  return { name, team: e.team || null };
}

// 作業ログに残すショートカットの名前の控え {id: {name, team}}
function checkShortcutNames(v) {
  const out = {};
  if (v == null) return out;
  if (!isObject(v)) fail('ショートカットの名前の控えの形が正しくありません');
  const ids = Object.keys(v);
  if (ids.length > LIMITS.shortcuts) fail(`ショートカットの名前の控えが多すぎます（${LIMITS.shortcuts}件まで）`);
  ids.forEach((id, i) => { out[id] = checkShortcutEntry(id, v[id], `ショートカットの名前の控え${i + 1}`); });
  return out;
}

// 作業ログをファイルに保存するときに一緒に入れるショートカットの一覧 [{id, name, team}]
function checkShortcutList(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail('ショートカットの一覧が配列ではありません');
  if (v.length > LIMITS.shortcuts) fail(`ショートカットが多すぎます（${LIMITS.shortcuts}件まで）`);
  return v.map((s, i) => {
    const at = `ショートカット${i + 1}`;
    if (!isObject(s)) fail(`${at}の形が正しくありません`);
    return { id: s.id, ...checkShortcutEntry(s.id, s, at) };
  });
}

// 作業ログを確かめ、決まった項目だけで作り直す。正しくなければ LogError（理由つき）
function checkLog(raw) {
  if (!isObject(raw)) fail('作業ログの形ではありません');
  if (raw.version == null) fail('バージョンがありません');
  if (raw.version !== VERSION) fail(`対応していないバージョンです（${String(raw.version).slice(0, 20)}）`);
  if (raw.id == null) fail('ID がありません');
  if (!isId(raw.id)) fail('ID の形が正しくありません');
  const video = checkVideo(raw.video);
  if (raw.scenes == null) fail('シーンの一覧がありません');
  if (!Array.isArray(raw.scenes)) fail('シーンの一覧が配列ではありません');
  if (raw.scenes.length > LIMITS.scenes) fail(`シーンが多すぎます（${LIMITS.scenes}件まで）`);
  const ids = new Set();
  const scenes = raw.scenes.map((s, i) => {
    const scene = checkScene(s, i + 1, video.duration);
    if (ids.has(scene.id)) fail(`シーン${i + 1}：ID がほかのシーンと重なっています`);
    ids.add(scene.id);
    return scene;
  });
  // 作った順がないシーンは、一覧の順に続きの番号を振る
  let maxSeq = scenes.reduce((m, s) => Math.max(m, s.seq || 0), 0);
  for (const s of scenes) if (s.seq == null) s.seq = ++maxSeq;
  let nextSeq = 1;
  if (raw.nextSeq != null) {
    if (!Number.isSafeInteger(raw.nextSeq) || raw.nextSeq < 1) fail('作った順の続きの番号の形が正しくありません');
    nextSeq = raw.nextSeq;
  }
  const now = new Date().toISOString();
  const createdAt = text(raw.createdAt, '作った日', LIMITS.date, null);
  return {
    version: VERSION,
    id: raw.id,
    createdAt: createdAt || now,
    updatedAt: text(raw.updatedAt, '最後に作業した日', LIMITS.date, null) || createdAt || now,
    gameName: text(raw.gameName, '試合名', LIMITS.text, ''),
    teamA: text(raw.teamA, 'チームAの名前', LIMITS.text, ''),
    teamB: text(raw.teamB, 'チームBの名前', LIMITS.text, ''),
    video,
    lastPosition: amount(raw.lastPosition, '前回止めた位置', 0),
    nextSeq: Math.max(nextSeq, maxSeq + 1),
    scenes,
    shortcutNames: checkShortcutNames(raw.shortcutNames)
  };
}

// ファイルから読み込む作業ログ {kind, log, shortcuts} を確かめる。
// ID がない・形が違うときは newId() で振り直す。一緒に入っているショートカットは名前の控えに足す。
function checkImport(data, newId) {
  if (!isObject(data) || data.kind !== 'moment-worklog' || !isObject(data.log)) fail('Moment の作業ログではありません');
  const shortcuts = checkShortcutList(data.shortcuts);
  const log = checkLog({ ...data.log, id: isId(data.log.id) ? data.log.id : newId() });
  // 取り込み先にないショートカットは、名前の控えで表示できるようにする
  for (const s of shortcuts) if (!log.shortcutNames[s.id]) log.shortcutNames[s.id] = { name: s.name, team: s.team };
  return log;
}

module.exports = { VERSION, LIMITS, DURATION_SLACK, LogError, checkLog, checkImport, checkShortcutList };
