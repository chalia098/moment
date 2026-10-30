// 作業ログの形の決まり（main/worklog.js）のテスト
const test = require('node:test');
const assert = require('node:assert');
const W = require('../main/worklog.js');
const { validLog } = require('./helpers');

test('正しい作業ログは、決まった項目だけで作り直す', () => {
  const raw = validLog();
  raw.evil = { polluted: true };
  raw.video.url = 'file:///x';
  raw.scenes[0].extra = 1;
  const log = W.checkLog(raw);
  const expected = validLog();
  assert.deepStrictEqual(log, expected);
  assert.notStrictEqual(log.scenes, raw.scenes, '受け取った配列をそのまま使わない');
});

test('なくてもよい項目は初期値で補う', () => {
  const log = W.checkLog({
    version: 1, id: 'old-1', video: { fingerprint: 'abc' },
    scenes: [{ id: 's-2', seq: 5, start: 3, end: 4 }, { id: 's-1', start: 1, end: 2 }]
  });
  assert.deepStrictEqual([log.gameName, log.teamA, log.teamB, log.lastPosition, log.shortcutNames], ['', '', '', 0, {}]);
  assert.deepStrictEqual(log.video, { fingerprint: 'abc', fileName: '', lastPath: null, size: null, duration: null });
  assert.deepStrictEqual(log.scenes.map(s => [s.id, s.seq, s.tags, s.titleOverride, s.memo]), [['s-2', 5, [], null, ''], ['s-1', 6, [], null, '']]);
  assert.strictEqual(log.nextSeq, 7);
  assert.ok(log.createdAt && log.updatedAt);
});

test('動画の長さ：読めない長さは不明として扱い、少しのはみ出しは許す', () => {
  const a = validLog();
  a.video.duration = Infinity;
  a.scenes[1].end = 99999;
  assert.strictEqual(W.checkLog(a).video.duration, null);
  const b = validLog();
  b.video.duration = 45;
  b.scenes[1].end = 45 + W.DURATION_SLACK;
  assert.doesNotThrow(() => W.checkLog(b));
});

const BAD = [
  ['作業ログでない', () => [], /作業ログの形ではありません/],
  ['バージョンがない', l => { delete l.version; }, /バージョンがありません/],
  ['対応していないバージョン', l => { l.version = 2; }, /対応していないバージョン/],
  ['ID がない', l => { delete l.id; }, /ID がありません/],
  ['ID の形', l => { l.id = '../etc'; }, /ID の形が正しくありません/],
  ['動画がない', l => { delete l.video; }, /動画の情報がありません/],
  ['指紋がない', l => { delete l.video.fingerprint; }, /動画の指紋がありません/],
  ['動画の長さが文字列', l => { l.video.duration = '60'; }, /動画の長さが数ではありません/],
  ['シーンの一覧がない', l => { delete l.scenes; }, /シーンの一覧がありません/],
  ['シーンの一覧が配列でない', l => { l.scenes = {}; }, /シーンの一覧が配列ではありません/],
  ['シーンが多すぎる', l => { l.scenes = Array.from({ length: W.LIMITS.scenes + 1 }, (_, i) => ({ id: `s${i}`, start: 0, end: 1 })); }, /シーンが多すぎます/],
  ['シーンの ID が重なる', l => { l.scenes[1].id = l.scenes[0].id; }, /シーン2：ID がほかのシーンと重なっています/],
  ['シーンの ID がない', l => { delete l.scenes[0].id; }, /シーン1：ID の形/],
  ['タグの形', l => { l.scenes[0].tags = ['a b']; }, /シーン1：タグの形が正しくありません/],
  ['タグが組み込みの名前', l => { l.scenes[0].tags = ['constructor']; }, /タグの形/],
  ['タグが配列でない', l => { l.scenes[0].tags = 'a-setof'; }, /タグが配列ではありません/],
  ['タグが多すぎる', l => { l.scenes[0].tags = Array.from({ length: W.LIMITS.tagsPerScene + 1 }, (_, i) => `t${i}`); }, /タグが多すぎます/],
  ['開始が文字列', l => { l.scenes[0].start = '10'; }, /シーン1：開始が数になっていません/],
  ['開始が NaN', l => { l.scenes[0].start = NaN; }, /開始が数になっていません/],
  ['終了が無限', l => { l.scenes[0].end = Infinity; }, /終了が数になっていません/],
  ['開始が0より前', l => { l.scenes[0].start = -1; }, /シーン1：開始が0より前です/],
  ['終了が開始と同じ', l => { l.scenes[0].end = l.scenes[0].start; }, /終了が開始より後になっていません/],
  ['動画の長さを超える', l => { l.video.duration = 40; }, /シーン2：終了が動画の長さを超えています/],
  ['作った順の形', l => { l.scenes[0].seq = 1.5; }, /作った順の形/],
  ['メモが長すぎる', l => { l.scenes[0].memo = 'あ'.repeat(W.LIMITS.memo + 1); }, /メモが長すぎます/],
  ['タイトルが文字列でない', l => { l.scenes[0].titleOverride = 5; }, /タイトルが文字列ではありません/],
  ['試合名が文字列でない', l => { l.gameName = 123; }, /試合名が文字列ではありません/],
  ['チーム名が長すぎる', l => { l.teamA = 'A'.repeat(W.LIMITS.text + 1); }, /チームAの名前が長すぎます/],
  ['動画の場所が長すぎる', l => { l.video.lastPath = '/'.repeat(W.LIMITS.path + 1); }, /動画の場所が長すぎます/],
  ['前回止めた位置が文字列', l => { l.lastPosition = '12'; }, /前回止めた位置が数ではありません/],
  ['控えが配列', l => { l.shortcutNames = []; }, /名前の控えの形が正しくありません/],
  ['控えのチーム', l => { l.shortcutNames['a-setof'].team = 'C'; }, /チームは A・B・なしのどれか/],
  ['控えの名前がない', l => { delete l.shortcutNames['a-setof'].name; }, /名前がありません/],
  ['控えの ID が __proto__', l => { l.shortcutNames = JSON.parse('{"__proto__": {"name": "x"}}'); }, /ID の形/]
];

for (const [name, change, message] of BAD) {
  test(`正しくない作業ログは理由をつけて止める：${name}`, () => {
    const log = validLog();
    const replaced = change(log);
    assert.throws(() => W.checkLog(replaced || log), err => err instanceof W.LogError && message.test(err.message));
  });
}

test('ファイルから読み込む：印・ショートカットを確かめ、ID を振り直し、控えに足す', () => {
  const newId = () => 'new-id-1';
  assert.throws(() => W.checkImport({ log: validLog() }, newId), /Moment の作業ログではありません/);
  assert.throws(() => W.checkImport({ kind: 'moment-worklog', log: validLog(), shortcuts: {} }, newId), /ショートカットの一覧が配列ではありません/);
  assert.throws(() => W.checkImport({ kind: 'moment-worklog', log: validLog(), shortcuts: [{ id: 'x 1', name: 'a' }] }, newId), /ショートカット1：ID の形/);
  assert.throws(() => W.checkImport({ kind: 'moment-worklog', log: validLog(), shortcuts: Array.from({ length: W.LIMITS.shortcuts + 1 }, (_, i) => ({ id: `k${i}`, name: 'a' })) }, newId), /ショートカットが多すぎます/);

  const log = W.checkImport({
    kind: 'moment-worklog',
    log: { ...validLog(), id: '' },
    shortcuts: [{ id: 'a-setof', name: '別の名前', team: 'A' }, { id: 'x-1', name: '速攻', team: null, key: { code: 'KeyQ' } }]
  }, newId);
  assert.strictEqual(log.id, 'new-id-1');
  assert.deepStrictEqual(log.shortcutNames['a-setof'], { name: 'setOF', team: 'A' }, '作業ログにある控えを優先する');
  assert.deepStrictEqual(log.shortcutNames['x-1'], { name: '速攻', team: null });
  assert.strictEqual(({}).polluted, undefined);
});
