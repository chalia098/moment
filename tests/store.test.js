// 作業ログの保存と読み込みのテスト。tests/ の中の一時フォルダだけを使い、実際の作業ログには触れない
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../main/store.js');
const { LIMITS } = require('../main/worklog.js');
const { makeTmpRoot, removeTmpRoot, validLog } = require('./helpers');

const root = makeTmpRoot();
test.after(() => removeTmpRoot(root));

const newStore = name => new Store(path.join(root, name));
const readLog = (store, id) => JSON.parse(fs.readFileSync(store.logPath(id), 'utf8'));
const leftovers = store => fs.readdirSync(store.logDir).filter(n => n.endsWith('.tmp'));

test('連続して保存しても、最後に受け付けたデータが残る', async () => {
  const store = newStore('burst');
  const base = validLog();
  const saves = [];
  for (let i = 0; i < 40; i++) saves.push(store.saveLog({ ...base, gameName: `試合${i}` }));
  await Promise.all(saves);
  assert.strictEqual(readLog(store, base.id).gameName, '試合39');
  assert.deepStrictEqual(leftovers(store), []);
});

test('保存するのは受け付けた時点のデータ。あとから変えても影響しない', async () => {
  const store = newStore('snapshot');
  const log = validLog();
  const saving = store.saveLog(log);
  log.gameName = 'あとから変えた';
  log.scenes.push({ id: 's-3', start: 50, end: 60 });
  await saving;
  const saved = readLog(store, log.id);
  assert.strictEqual(saved.gameName, '日本選手権予選');
  assert.strictEqual(saved.scenes.length, 2);

  const file = path.join(store.baseDir, 'settings.json');
  const data = { theme: 'dark' };
  const writing = store.writeJson(file, data);
  data.theme = 'light';
  await writing;
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
});

test('保存に一度失敗しても前の作業ログは壊れず、次の保存は続けられる', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const store = newStore('fail');
  const log = validLog();
  await store.saveLog({ ...log, gameName: '最初' });
  fs.chmodSync(store.logDir, 0o555);
  try {
    await assert.rejects(store.saveLog({ ...log, gameName: '書けない' }));
  } finally {
    fs.chmodSync(store.logDir, 0o755);
  }
  assert.strictEqual(readLog(store, log.id).gameName, '最初');
  await store.saveLog({ ...log, gameName: '次' });
  assert.strictEqual(readLog(store, log.id).gameName, '次');
  assert.deepStrictEqual(leftovers(store), []);
});

test('終了するときは、受け付けた保存が全部終わるまで待てる', async () => {
  const store = newStore('idle');
  const log = validLog();
  for (let i = 0; i < 10; i++) store.saveLog({ ...log, gameName: `試合${i}` });
  await store.idle();
  assert.strictEqual(store.writing.size, 0);
  assert.strictEqual(readLog(store, log.id).gameName, '試合9');
});

test('同時に書いても一時ファイルの名前が重ならない', async () => {
  const dir = path.join(root, 'two');
  const s1 = new Store(dir);
  const s2 = new Store(dir);
  const log = validLog();
  const all = [];
  for (let i = 0; i < 20; i++) {
    all.push(s1.saveLog({ ...log, gameName: `a${i}` }));
    all.push(s2.saveLog({ ...log, gameName: `b${i}` }));
  }
  await Promise.all(all);
  assert.match(readLog(s1, log.id).gameName, /^[ab]\d+$/);
  assert.deepStrictEqual(leftovers(s1), []);
});

test('正しくない作業ログは保存も取り込みもせず、既存の作業ログは変わらない', async () => {
  const store = newStore('invalid');
  const log = validLog();
  await store.saveLog(log);
  const file = store.logPath(log.id);
  const before = fs.readFileSync(file, 'utf8');

  const bad = validLog();
  bad.scenes[0].end = 5;
  await assert.rejects(store.saveLog(bad), { name: 'LogError', message: 'シーン1：終了が開始より後になっていません' });

  const write = (name, content) => { const p = path.join(root, name); fs.writeFileSync(p, content); return p; };
  const newer = write('newer.moment.json', JSON.stringify({ kind: 'moment-worklog', log: { ...validLog(), version: 2, gameName: '上書き' } }));
  await assert.rejects(store.readImport(newer), { name: 'LogError', message: /対応していないバージョン/ });
  const broken = write('broken.moment.json', '{"kind": "moment-worklog", "log": ');
  await assert.rejects(store.readImport(broken), { name: 'LogError', message: 'JSON として読めません' });
  const other = write('other.json', JSON.stringify({ hello: 'world' }));
  await assert.rejects(store.readImport(other), { name: 'LogError', message: 'Moment の作業ログではありません' });
  const big = write('big.moment.json', Buffer.alloc(LIMITS.fileBytes + 1, 0x20));
  await assert.rejects(store.readImport(big), { name: 'LogError', message: /ファイルが大きすぎます/ });
  const badShortcut = write('shortcut.moment.json', JSON.stringify({ kind: 'moment-worklog', log: validLog(), shortcuts: [{ id: 'x-1', name: 42 }] }));
  await assert.rejects(store.readImport(badShortcut), { name: 'LogError', message: 'ショートカット1：名前が文字列ではありません' });

  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(leftovers(store), []);
});

test('取り込み：確かめた項目だけで作り直し、ショートカットの名前を控えに足す', async () => {
  const store = newStore('import');
  const source = { ...validLog(), id: 'bad id!', evil: { polluted: true } };
  const data = { kind: 'moment-worklog', log: source, shortcuts: [{ id: 'x-1', name: '速攻', team: 'A', key: { code: 'KeyQ' } }] };
  const file = path.join(root, 'import.moment.json');
  fs.writeFileSync(file, JSON.stringify(data));
  const { log, exists } = await store.readImport(file);
  assert.match(log.id, /^[0-9a-f-]{36}$/, 'ID の形が正しくなければ新しく振る');
  assert.strictEqual(exists, false);
  assert.strictEqual(log.evil, undefined);
  assert.deepStrictEqual(log.shortcutNames['x-1'], { name: '速攻', team: 'A' });
  assert.deepStrictEqual(log.shortcutNames['a-setof'], { name: 'setOF', team: 'A' }, '作業ログにある控えはそのまま');

  await store.saveLog(validLog());
  const again = await store.importLog({ kind: 'moment-worklog', log: validLog() });
  assert.strictEqual(again.exists, true);
});

test('開くとき：壊れた・正しくない作業ログは開かず、なくてもよい項目がない古い作業ログは初期値で開く', async () => {
  const store = newStore('open');
  fs.writeFileSync(store.logPath('broken-1'), '{not json');
  assert.strictEqual(await store.getLog('broken-1'), null);
  fs.writeFileSync(store.logPath('wrong-1'), JSON.stringify({ ...validLog(), id: 'wrong-1', scenes: 'none' }));
  assert.strictEqual(await store.getLog('wrong-1'), null);

  fs.writeFileSync(store.logPath('legacy-1'), JSON.stringify({ version: 1, id: 'legacy-1', video: { fingerprint: 'abc' }, scenes: [{ id: 's1', start: 1, end: 2 }] }));
  const log = await store.getLog('legacy-1');
  assert.deepStrictEqual(
    [log.gameName, log.teamA, log.lastPosition, log.nextSeq, log.video.duration, log.shortcutNames],
    ['', '', 0, 2, null, {}]);
  assert.deepStrictEqual(log.scenes, [{ id: 's1', seq: 1, start: 1, end: 2, tags: [], titleOverride: null, memo: '' }]);
  assert.strictEqual((await store.findLogByFingerprint('abc')).id, 'legacy-1');
});
