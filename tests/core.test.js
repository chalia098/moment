// node --test tests/ で動く、決まりごとのテスト
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/lib/core.js');

test('時刻の表示', () => {
  assert.strictEqual(C.formatTime(0), '00:00:000');
  assert.strictEqual(C.formatTime(5), '00:05:000');
  assert.strictEqual(C.formatTime(65), '01:05:000');
  assert.strictEqual(C.formatTime(754.9), '12:34:900');
  assert.strictEqual(C.formatTime(1.005), '00:01:005');
  assert.strictEqual(C.formatTime(59.9996), '00:59:999');
  assert.strictEqual(C.formatTime(3735), '1:02:15:000');
  assert.strictEqual(C.formatTime(3735.48), '1:02:15:480');
  assert.strictEqual(C.formatTime(NaN), '00:00:000');
});

test('タグ一覧の時刻の表示はミリ秒を出さない', () => {
  assert.strictEqual(C.formatTimeShort(0), '00:00');
  assert.strictEqual(C.formatTimeShort(5.999), '00:05');
  assert.strictEqual(C.formatTimeShort(754.9), '12:34');
  assert.strictEqual(C.formatTimeShort(3735.48), '1:02:15');
  assert.strictEqual(C.formatTimeShort(NaN), '00:00');
});

test('時刻の読み取り', () => {
  assert.strictEqual(C.parseTime('52:39'), 3159);
  assert.strictEqual(C.parseTime('52:39:120'), 3159.12);
  assert.strictEqual(C.parseTime('00:05:000'), 5);
  assert.strictEqual(C.parseTime('1:02:15'), 3735);
  assert.strictEqual(C.parseTime('1:02:15:480'), 3735.48);
  assert.strictEqual(C.parseTime('５２：３９：１２０'), 3159.12);
  assert.strictEqual(C.parseTime('７５'), 75);
  assert.strictEqual(C.parseTime('1:75'), null);
  assert.strictEqual(C.parseTime('52:39:1200'), null);
  assert.strictEqual(C.parseTime('1:02:15:48'), null);
  assert.strictEqual(C.parseTime('52:60:000'), null);
  assert.strictEqual(C.parseTime('abc'), null);
});

test('表示した時刻を読み取ると、ミリ秒まで同じに戻る', () => {
  for (const sec of [0, 0.001, 3159.12, 3599.999, 3735.48, 5400.25]) {
    assert.strictEqual(C.formatTime(C.parseTime(C.formatTime(sec))), C.formatTime(sec));
  }
});

test('タイトルは押した順に「チーム名＋名前」をつなげる', () => {
  const s = C.defaultSettings();
  const game = { teamA: '順天堂', teamB: '渡辺組' };
  assert.strictEqual(C.autoTitle(['a-setof'], game, s), '順天堂 setOF');
  assert.strictEqual(C.autoTitle(['a-setof', 'n-65'], game, s), '順天堂 setOF 6:5');
  assert.strictEqual(C.autoTitle(['b-fb'], game, s), '渡辺組 FB');
  assert.strictEqual(C.autoTitle([], game, s), '');
  assert.strictEqual(C.autoTitle(['a-setof'], { teamA: '', teamB: '' }, s), 'チームA setOF');
});

test('手で書き換えたタイトルはそのまま', () => {
  const s = C.defaultSettings();
  const scene = { tags: ['a-setof'], titleOverride: '速攻からのセット' };
  assert.strictEqual(C.sceneTitle(scene, { teamA: '順天堂' }, s), '速攻からのセット');
});

test('名前を変えると過去のタグもついてくる。消しても残る', () => {
  const s = C.defaultSettings();
  const game = { teamA: '順天堂' };
  s.shortcuts.find(x => x.id === 'a-fb').name = '速攻';
  assert.strictEqual(C.autoTitle(['a-fb'], game, s), '順天堂 速攻');
  const gone = s.shortcuts.splice(0, 1)[0];
  s.deletedShortcuts.push({ id: gone.id, name: gone.name, team: gone.team });
  assert.strictEqual(C.autoTitle(['a-setof'], game, s), '順天堂 setOF');
  assert.strictEqual(C.autoTitle(['zzz'], game, s, { zzz: { name: '移した名前', team: null } }), '移した名前');
});

test('ファイル名：使えない文字を置き換え、同じタイトルの中で時刻順に番号', () => {
  assert.strictEqual(C.sanitizeFileName('順天堂 setOF 6:5'), '順天堂 setOF 6-5');
  assert.strictEqual(C.sanitizeFileName('a/b'), 'a-b');
  assert.strictEqual(C.sanitizeFileName(''), 'タイトルなし');
  const names = C.planFileNames([
    { id: 'x', title: '順天堂 setOF', start: 50 },
    { id: 'y', title: '順天堂 setOF', start: 10 },
    { id: 'z', title: '順天堂 setOF 6:5', start: 30 },
    { id: 'w', title: '', start: 5 }
  ]);
  assert.strictEqual(names.get('y'), '順天堂 setOF 01.mp4');
  assert.strictEqual(names.get('x'), '順天堂 setOF 02.mp4');
  assert.strictEqual(names.get('z'), '順天堂 setOF 6-5 01.mp4');
  assert.strictEqual(names.get('w'), 'タイトルなし 01.mp4');
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, title: 'FB', start: i }));
  assert.strictEqual(C.planFileNames(many).get('s0'), 'FB 001.mp4');
});

test('ファイル名（プレイリスト）：プレイリストの順に番号を前に付ける。100本以上なら3桁', () => {
  const names = C.playlistFileNames([
    { id: 'b', title: '渡辺組 FB' },
    { id: 'a', title: '順天堂 setOF 6:5' },
    { id: 'c', title: '' },
    { id: 'd', title: '渡辺組 FB' }
  ]);
  assert.deepStrictEqual([...names.values()], ['01 渡辺組 FB.mp4', '02 順天堂 setOF 6-5.mp4', '03 タイトルなし.mp4', '04 渡辺組 FB.mp4']);
  const many = C.playlistFileNames(Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, title: 'FB' })));
  assert.strictEqual(many.get('s0'), '001 FB.mp4');
  assert.strictEqual(many.get('s99'), '100 FB.mp4');
});

test('ファイル名：大文字・小文字や Unicode の正規化だけが違うタイトルは、続きの番号にして同じ名前を作らない', () => {
  const nfd = 'が'.normalize('NFD');
  const names = C.planFileNames([
    { id: 'a', title: 'FB', start: 30 },
    { id: 'b', title: 'fb', start: 10 },
    { id: 'c', title: 'Fb', start: 20 },
    { id: 'd', title: 'が', start: 5 },
    { id: 'e', title: nfd, start: 6 },
    { id: 'f', title: 'FB 01', start: 1 }
  ]);
  assert.strictEqual(names.get('b'), 'fb 01.mp4');
  assert.strictEqual(names.get('c'), 'Fb 02.mp4');
  assert.strictEqual(names.get('a'), 'FB 03.mp4');
  assert.strictEqual(names.get('d'), 'が 01.mp4');
  assert.strictEqual(names.get('e'), `${nfd} 02.mp4`);
  assert.strictEqual(names.get('f'), 'FB 01 01.mp4');
  const keys = [...names.values()].map(C.fileNameKey);
  assert.strictEqual(new Set(keys).size, keys.length, '保存先で同じファイル名とみなされるものがない');
  assert.strictEqual(C.fileNameKey('FB 01.mp4'), C.fileNameKey('fb 01.MP4'));
});

test('キーの割り当て：重複と使えないキーを止める', () => {
  const s = C.defaultSettings();
  assert.match(C.keyProblem({ code: 'Digit1' }, s, { kind: 'shortcut', id: 'n-65' }), /setOF/);
  assert.match(C.keyProblem({ code: 'Comma' }, s, { kind: 'shortcut', id: 'n-65' }), /記録を開始/);
  assert.match(C.keyProblem({ code: 'KeyK', meta: true }, s, { kind: 'shortcut', id: 'n-65' }), /使えません/);
  assert.strictEqual(C.keyProblem({ code: 'KeyQ' }, s, { kind: 'shortcut', id: 'n-65' }), null);
  assert.strictEqual(C.keyProblem({ code: 'KeyW' }, s, { kind: 'shortcut', id: 'n-65' }), null, '自分自身のキーは重複にしない');
  assert.match(C.keyProblem({ code: 'Escape' }, s, { kind: 'base', id: 'cancel' }), /使えません/);
  assert.strictEqual(C.keyProblem({ code: 'KeyJ', meta: true }, s, { kind: 'base', id: 'toggleKeys' }), null);
});

test('キーの表示', () => {
  assert.strictEqual(C.keyLabel({ code: 'Comma' }, 'darwin'), '、');
  assert.strictEqual(C.keyLabel({ code: 'KeyP', shift: true }, 'darwin'), '⇧P');
  assert.strictEqual(C.keyLabel({ code: 'KeyK', meta: true }, 'win32'), 'Ctrl+K');
  assert.strictEqual(C.keyLabel({ code: 'F1' }, 'darwin'), 'F1');
});

test('並び順と絞り込み', () => {
  const rows = [
    { id: 'a', seq: 1, start: 30, title: '順天堂 setOF', team: 'A', tags: ['a-setof'], memo: '' },
    { id: 'b', seq: 2, start: 10, title: '渡辺組 FB', team: 'B', tags: ['b-fb'], memo: '速攻から' },
    { id: 'c', seq: 3, start: 20, title: '順天堂 setOF 6:5', team: 'A', tags: ['a-setof', 'n-65'], memo: '' }
  ];
  assert.deepStrictEqual(C.sortScenes(rows, 'timeDesc').map(r => r.id), ['a', 'c', 'b']);
  assert.deepStrictEqual(C.sortScenes(rows, 'timeAsc').map(r => r.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(C.sortScenes(rows, 'created').map(r => r.id), ['c', 'b', 'a']);
  assert.deepStrictEqual(C.filterScenes(rows, { kind: 'team', value: 'A' }).map(r => r.id), ['a', 'c']);
  assert.deepStrictEqual(C.filterScenes(rows, { kind: 'tag', value: 'n-65' }).map(r => r.id), ['c']);
  assert.deepStrictEqual(C.filterScenes(rows, { kind: 'all' }, '速攻').map(r => r.id), ['b']);
});

test('再開時は長さの差が1秒以内なら同じ映像として確かめる', () => {
  assert.strictEqual(C.sameDuration(3600.2, 3600.9), true);
  assert.strictEqual(C.sameDuration(3600, 3601), true);
  assert.strictEqual(C.sameDuration(3600, 3602), false);
  assert.strictEqual(C.sameDuration(null, 3600), false);
  assert.strictEqual(C.sameDuration(0, 0), false);
});
