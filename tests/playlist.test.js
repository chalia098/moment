// プレイリストの形の確かめと保存のテスト。tests/ の中の一時フォルダだけを使い、実際のプレイリストには触れない
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../main/store.js');
const { checkPlaylist, LIMITS } = require('../main/playlist.js');
const { makeTmpRoot, removeTmpRoot, validLog } = require('./helpers');

const root = makeTmpRoot();
test.after(() => removeTmpRoot(root));

const newStore = name => new Store(path.join(root, name));

function validPlaylist() {
  return {
    version: 1,
    id: 'pl-1',
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    name: '渡辺組 FB',
    items: [{ logId: 'log-1', sceneId: 's-2' }, { logId: 'log-1', sceneId: 's-1' }]
  };
}

test('プレイリスト：確かめた項目だけで作り直し、順番はそのまま', () => {
  const pl = checkPlaylist({ ...validPlaylist(), extra: 'x', items: [{ logId: 'log-1', sceneId: 's-2', note: 'x' }, { logId: 'log-2', sceneId: 's-1' }] });
  assert.deepStrictEqual(Object.keys(pl).sort(), ['createdAt', 'id', 'items', 'name', 'updatedAt', 'version']);
  assert.deepStrictEqual(pl.items, [{ logId: 'log-1', sceneId: 's-2' }, { logId: 'log-2', sceneId: 's-1' }]);
});

test('プレイリスト：なくてもよい項目がないときは初期値で補う', () => {
  const pl = checkPlaylist({ version: 1, id: 'pl-2', items: [] });
  assert.strictEqual(pl.name, '');
  assert.ok(pl.createdAt && pl.updatedAt);
});

test('プレイリスト：正しくないものは理由をつけて止める', () => {
  const bad = (patch, message) => assert.throws(() => checkPlaylist({ ...validPlaylist(), ...patch }), { name: 'LogError', message });
  bad({ version: 2 }, '対応していないバージョンです（2）');
  bad({ id: '../x' }, 'ID の形が正しくありません');
  bad({ id: '__proto__' }, 'ID の形が正しくありません');
  bad({ items: null }, 'シーンの一覧がありません');
  bad({ items: 'x' }, 'シーンの一覧が配列ではありません');
  bad({ items: [{ logId: 'log-1' }] }, 'シーン1：シーンの ID の形が正しくありません');
  bad({ items: [{ logId: 'log 1', sceneId: 's-1' }] }, 'シーン1：作業ログの ID の形が正しくありません');
  bad({ items: [{ logId: 'log-1', sceneId: 's-1' }, { logId: 'log-1', sceneId: 's-1' }] }, 'シーン2：同じシーンがもう入っています');
  bad({ name: 'x'.repeat(LIMITS.name + 1) }, `名前が長すぎます（${LIMITS.name}文字まで）`);
  bad({ items: new Array(LIMITS.items + 1).fill({ logId: 'a', sceneId: 'b' }) }, `シーンが多すぎます（${LIMITS.items}件まで）`);
});

test('プレイリストの保存：正しくなければ書かず、既存のプレイリストは変わらない', async () => {
  const store = newStore('save');
  await store.savePlaylist(validPlaylist());
  const before = fs.readFileSync(store.playlistPath('pl-1'), 'utf8');
  await assert.rejects(store.savePlaylist({ ...validPlaylist(), items: 'x' }), { name: 'LogError' });
  assert.strictEqual(fs.readFileSync(store.playlistPath('pl-1'), 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(store.playlistDir).filter(n => n.endsWith('.tmp')), []);
});

test('プレイリストの一覧：本数と、見つかるシーンだけの合計の長さ。壊れたものは名前だけ出す', async () => {
  const store = newStore('list');
  await store.saveLog(validLog()); // s-1: 10→20, s-2: 30→45.5
  await store.savePlaylist({ ...validPlaylist(), items: [{ logId: 'log-1', sceneId: 's-2' }, { logId: 'log-1', sceneId: 's-1' }, { logId: 'gone', sceneId: 's-1' }] });
  fs.writeFileSync(store.playlistPath('pl-bad'), JSON.stringify({ version: 1, id: 'pl-bad', name: '壊れた', items: 'x' }));
  const list = await store.listPlaylists();
  const ok = list.find(p => p.id === 'pl-1');
  assert.deepStrictEqual([ok.name, ok.itemCount, ok.totalSec, ok.broken], ['渡辺組 FB', 3, 25.5, false]);
  const broken = list.find(p => p.id === 'pl-bad');
  assert.deepStrictEqual([broken.name, broken.broken], ['壊れた', true]);
  assert.strictEqual(await store.getPlaylist('pl-bad'), null);
  assert.strictEqual((await store.getPlaylist('pl-1')).items.length, 3);
});

test('プレイリストの削除：中のシーン（作業ログ）は消えない', async () => {
  const store = newStore('delete');
  await store.saveLog(validLog());
  await store.savePlaylist(validPlaylist());
  await store.deletePlaylist('pl-1');
  assert.strictEqual(await store.getPlaylist('pl-1'), null);
  assert.strictEqual((await store.getLog('log-1')).scenes.length, 2);
});
