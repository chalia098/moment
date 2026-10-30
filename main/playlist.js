// プレイリストの形の決まり。画面から届いたものや保存してあるものを確かめ、
// 確かめた項目だけで作り直す（受け取ったものをそのまま保存しない）。
// プレイリストは「どの作業ログのどのシーンか」と順番だけを持つ。シーンそのものは作業ログにある。
const { LogError, isId, isObject, text } = require('./worklog');

const VERSION = 1;
const LIMITS = {
  items: 10000,
  name: 1000,
  date: 64
};

function fail(message) { throw new LogError(message); }

function checkItem(it, n) {
  const at = `シーン${n}`;
  if (!isObject(it)) fail(`${at}の形が正しくありません`);
  if (!isId(it.logId)) fail(`${at}：作業ログの ID の形が正しくありません`);
  if (!isId(it.sceneId)) fail(`${at}：シーンの ID の形が正しくありません`);
  return { logId: it.logId, sceneId: it.sceneId };
}

// プレイリストを確かめ、決まった項目だけで作り直す。正しくなければ LogError（理由つき）
function checkPlaylist(raw) {
  if (!isObject(raw)) fail('プレイリストの形ではありません');
  if (raw.version == null) fail('バージョンがありません');
  if (raw.version !== VERSION) fail(`対応していないバージョンです（${String(raw.version).slice(0, 20)}）`);
  if (raw.id == null) fail('ID がありません');
  if (!isId(raw.id)) fail('ID の形が正しくありません');
  if (raw.items == null) fail('シーンの一覧がありません');
  if (!Array.isArray(raw.items)) fail('シーンの一覧が配列ではありません');
  if (raw.items.length > LIMITS.items) fail(`シーンが多すぎます（${LIMITS.items}件まで）`);
  const seen = new Set();
  const items = raw.items.map((it, i) => {
    const item = checkItem(it, i + 1);
    const key = `${item.logId}/${item.sceneId}`;
    if (seen.has(key)) fail(`シーン${i + 1}：同じシーンがもう入っています`);
    seen.add(key);
    return item;
  });
  const now = new Date().toISOString();
  const createdAt = text(raw.createdAt, '作った日', LIMITS.date, null);
  return {
    version: VERSION,
    id: raw.id,
    createdAt: createdAt || now,
    updatedAt: text(raw.updatedAt, '最後に変えた日', LIMITS.date, null) || createdAt || now,
    name: text(raw.name, '名前', LIMITS.name, ''),
    items
  };
}

module.exports = { VERSION, LIMITS, checkPlaylist };
