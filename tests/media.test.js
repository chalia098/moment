// 書き出しと動画を調べる処理のテスト。偽の ffmpeg（fake-ffmpeg.js）と tests/ の中の一時フォルダだけを使う
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeTmpRoot, removeTmpRoot, fakeFfmpeg, waitFor } = require('./helpers');

const root = makeTmpRoot();
const ffmpeg = fakeFfmpeg(root);
process.env.MOMENT_FFMPEG = ffmpeg;
const media = require('../main/media.js');

const video = path.join(root, 'game.mp4');
fs.writeFileSync(video, 'video');

// 止まる ffmpeg を時間切れにするまでの長さ。偽の ffmpeg が起動して自分の番号を書くまで待てる長さにする
const HANG_TIMEOUT_MS = 2000;
const FAKE_KEYS = ['FAKE_FF_STATE', 'FAKE_FF_PIDFILE', 'FAKE_FF_PROBE', 'FAKE_FF_ENCODERS', 'FAKE_FF_FAIL_AT', 'FAKE_FF_HANG_AT', 'FAKE_FF_TOUCH', 'FAKE_FF_TOUCH_AT'];
test.afterEach(() => { for (const k of FAKE_KEYS) delete process.env[k]; });
test.after(() => removeTmpRoot(root));

// テストごとの保存先と、偽の ffmpeg の数え札
function setup(name, env = {}) {
  const dest = path.join(root, name);
  fs.mkdirSync(dest);
  Object.assign(process.env, { FAKE_FF_STATE: path.join(root, `${name}.count`), FAKE_FF_PIDFILE: path.join(root, `${name}.pids`) }, env);
  return dest;
}
const encodeCount = () => Number(fs.existsSync(process.env.FAKE_FF_STATE) ? fs.readFileSync(process.env.FAKE_FF_STATE, 'utf8') : 0);
const listAll = dir => fs.readdirSync(dir, { recursive: true }).sort();
const read = p => fs.readFileSync(p, 'utf8');

// 起動した偽の ffmpeg が1つも残っていないこと
function assertNoChildren(pidfile) {
  const pids = read(pidfile).split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length > 0, 'ffmpeg が起動していない');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `ffmpeg（${pid}）が残っている`);
}

function exportOpts(dest, items, extra = {}) {
  return { input: video, dest, gameName: '試合', quality: 'source', mode: 'separate', items, ...extra };
}

// 書き出し方式は一度うまくいくと覚えるので、時間切れのテストを最初に置く
test('書き出し方式の確認：時間切れは覚えず、次はやり直せる。止めた ffmpeg は残さない', async () => {
  setup('encoders', { FAKE_FF_ENCODERS: 'hang' });
  await assert.rejects(media.videoEncoderArgs({ timeoutMs: HANG_TIMEOUT_MS }), { message: 'ffmpeg の確認に時間がかかりすぎました' });
  assertNoChildren(process.env.FAKE_FF_PIDFILE);
  delete process.env.FAKE_FF_ENCODERS;
  const enc = await media.videoEncoderArgs();
  assert.ok(enc.includes('libx264'));
});

test('動画を調べる：長さ・映像・音声を読む', async () => {
  setup('probe-ok');
  const r = await media.probe(video);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.duration, 100.5);
  assert.deepStrictEqual([r.video.codec, r.video.width, r.video.height], ['h264', 1920, 1080]);
  assert.deepStrictEqual([r.audio.codec, r.audio.rate], ['aac', 48000]);
});

test('動画を調べる：時間切れでも待っている間に画面（イベントループ）を止めず、ffmpeg を残さない。次はまた調べられる', async () => {
  setup('probe-hang', { FAKE_FF_PROBE: 'hang' });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const r = await media.probe(video, { timeoutMs: HANG_TIMEOUT_MS });
  clearInterval(timer);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'timeout');
  assert.strictEqual(r.reason, '動画を調べるのに時間がかかりすぎました');
  assert.ok(ticks >= 10, `調べている間にほかの処理が動いていない（${ticks}回）`);
  assertNoChildren(process.env.FAKE_FF_PIDFILE);
  delete process.env.FAKE_FF_PROBE;
  assert.strictEqual((await media.probe(video)).ok, true);
});

test('動画を調べる：読み取れない結果は解析失敗として分ける', async () => {
  setup('probe-garbage', { FAKE_FF_PROBE: 'garbage' });
  const r = await media.probe(video);
  assert.deepStrictEqual([r.ok, r.error, r.reason], [false, 'parse', 'この形式の動画は開けません']);
});

test('動画を調べる：出力が止まらなくても上限で止め、受け取った分だけで読む', async () => {
  setup('probe-flood', { FAKE_FF_PROBE: 'flood' });
  const started = Date.now();
  const r = await media.probe(video);
  assert.strictEqual(r.ok, true, '上限で止まらず時間切れになった');
  assert.strictEqual(r.duration, 100.5);
  assert.ok(Date.now() - started < 10000);
  assertNoChildren(process.env.FAKE_FF_PIDFILE);
});

test('動画を調べる：ffmpeg を起動できないときは起動失敗として分け、直れば次は調べられる', async () => {
  setup('probe-spawn');
  fs.chmodSync(ffmpeg, 0o644);
  try {
    const r = await media.probe(video);
    assert.deepStrictEqual([r.ok, r.error, r.reason], [false, 'spawn', 'ffmpeg を起動できません']);
  } finally {
    fs.chmodSync(ffmpeg, 0o755);
  }
  assert.strictEqual((await media.probe(video)).ok, true);
});

test('ダウンロード：「FB」と「fb」は別の名前になり、後の失敗で先に保存した動画を消さない', async () => {
  const dest = setup('collide', { FAKE_FF_FAIL_AT: '2' });
  const r = await media.exportScenes(new media.Job(), exportOpts(dest, [
    { id: 'a', title: 'FB', start: 0, end: 5 },
    { id: 'b', title: 'fb', start: 10, end: 15 }
  ]), () => {});
  assert.strictEqual(r.dir, path.join(dest, '試合'));
  assert.deepStrictEqual(r.results.map(x => [x.file, x.ok]), [['FB 01.mp4', true], ['fb 02.mp4', false]]);
  assert.strictEqual(r.results[1].reason, 'この動画は読み込めません');
  assert.strictEqual(read(path.join(r.dir, 'FB 01.mp4')), 'cut:1;');
  assert.deepStrictEqual(listAll(r.dir), ['FB 01.mp4'], '一時ファイルと作業用の隠しフォルダは残らない');
});

test('ダウンロード：書き出し中にほかのアプリが同じ名前を作っても、上書きも削除もしない', async () => {
  const dest = setup('race');
  const taken = path.join(dest, '試合', 'FB 01.mp4');
  Object.assign(process.env, { FAKE_FF_TOUCH: taken, FAKE_FF_TOUCH_AT: '1' });
  const r = await media.exportScenes(new media.Job(), exportOpts(dest, [
    { id: 'a', title: 'FB', start: 0, end: 5 },
    { id: 'b', title: 'PT', start: 6, end: 8 }
  ]), () => {});
  assert.deepStrictEqual(r.results.map(x => [x.file, x.ok, x.reason]), [
    ['FB 01.mp4', false, '同じ名前のファイルがあります'],
    ['PT 01.mp4', true, null]
  ]);
  assert.strictEqual(read(taken), 'other app');
  assert.deepStrictEqual(listAll(r.dir), ['FB 01.mp4', 'PT 01.mp4']);
});

test('ダウンロード：ハードリンクを作れない保存先でも、上書きせずに置ける', async () => {
  const link = fs.promises.link;
  fs.promises.link = async () => { const e = new Error('link is not supported'); e.code = 'ENOTSUP'; throw e; };
  try {
    const dest = setup('nolink');
    const taken = path.join(dest, '試合', 'PT 01.mp4');
    Object.assign(process.env, { FAKE_FF_TOUCH: taken, FAKE_FF_TOUCH_AT: '2' });
    const r = await media.exportScenes(new media.Job(), exportOpts(dest, [
      { id: 'a', title: 'FB', start: 0, end: 5 },
      { id: 'b', title: 'PT', start: 6, end: 8 }
    ]), () => {});
    assert.deepStrictEqual(r.results.map(x => [x.file, x.ok, x.reason]), [
      ['FB 01.mp4', true, null],
      ['PT 01.mp4', false, '同じ名前のファイルがあります']
    ]);
    assert.strictEqual(read(path.join(r.dir, 'FB 01.mp4')), 'cut:1;');
    assert.strictEqual(read(taken), 'other app');
    assert.deepStrictEqual(listAll(r.dir), ['FB 01.mp4', 'PT 01.mp4']);
  } finally {
    fs.promises.link = link;
  }
});

test('ダウンロード：中止すると動いている ffmpeg を止め、できあがったファイルは残し、一時ファイルだけ消す', async () => {
  const dest = setup('cancel', { FAKE_FF_HANG_AT: '2' });
  const job = new media.Job();
  const running = media.exportScenes(job, exportOpts(dest, [
    { id: 'a', title: 'FB', start: 0, end: 5 },
    { id: 'b', title: 'PT', start: 6, end: 8 },
    { id: 'c', title: 'PT', start: 9, end: 12 }
  ]), () => {});
  await waitFor(() => encodeCount() >= 2);
  await new Promise(r => setTimeout(r, 100));
  job.cancel();
  const r = await running;
  assert.strictEqual(r.cancelled, true);
  assert.deepStrictEqual(r.results.map(x => [x.file, x.ok]), [['FB 01.mp4', true]]);
  assert.deepStrictEqual(listAll(r.dir), ['FB 01.mp4']);
  assertNoChildren(process.env.FAKE_FF_PIDFILE);
});

test('1本に結合してダウンロード：失敗しても既存のファイルは残り、作業用のファイルも残さない', async () => {
  const dest = setup('merged-fail', { FAKE_FF_FAIL_AT: '3' });
  fs.mkdirSync(path.join(dest, '試合'));
  fs.writeFileSync(path.join(dest, '試合', 'まとめ.mp4'), 'before');
  const r = await media.exportScenes(new media.Job(), exportOpts(dest, [
    { id: 'a', title: 'FB', start: 0, end: 5 },
    { id: 'b', title: 'PT', start: 6, end: 8 }
  ], { mode: 'merged', mergedTitle: 'まとめ' }), () => {});
  assert.strictEqual(r.dir, path.join(dest, '試合 2'), '既存の試合フォルダには書かない');
  assert.deepStrictEqual(r.results.map(x => [x.file, x.ok]), [['まとめ.mp4', false]]);
  assert.strictEqual(read(path.join(dest, '試合', 'まとめ.mp4')), 'before');
  assert.deepStrictEqual(listAll(r.dir), []);
});

test('1本に結合してダウンロード：選んだ行を時刻順につないで置く', async () => {
  const dest = setup('merged-ok');
  const r = await media.exportScenes(new media.Job(), exportOpts(dest, [
    { id: 'b', title: 'PT', start: 6, end: 8 },
    { id: 'a', title: 'FB', start: 0, end: 5 }
  ], { mode: 'merged', mergedTitle: 'まとめ' }), () => {});
  assert.deepStrictEqual(r.results.map(x => [x.file, x.ok]), [['まとめ.mp4', true]]);
  assert.strictEqual(read(path.join(r.dir, 'まとめ.mp4')), 'cut:1;cut:2;');
  assert.deepStrictEqual(listAll(r.dir), ['まとめ.mp4']);
});

test('動画を結合：元のままでつなぎ、保存先に置く', async () => {
  const dest = setup('join-ok');
  const a = path.join(dest, 'a.mp4');
  const b = path.join(dest, 'b.mp4');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');
  const output = path.join(dest, 'out.mp4');
  const r = await media.mergeVideos(new media.Job(), { inputs: [a, b], output, quality: 'source' }, () => {});
  assert.deepStrictEqual(r, { ok: true, output });
  assert.strictEqual(read(output), 'AB');
  assert.deepStrictEqual(listAll(dest), ['a.mp4', 'b.mp4', 'out.mp4']);
});

test('動画を結合：同じ名前があれば始めない。途中で作られても上書きしない。失敗しても元の動画は残る', async () => {
  const dest = setup('join-guard');
  const a = path.join(dest, 'a.mp4');
  const b = path.join(dest, 'b.mp4');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');
  const job = () => new media.Job();

  const existing = path.join(dest, 'existing.mp4');
  fs.writeFileSync(existing, 'keep');
  const r1 = await media.mergeVideos(job(), { inputs: [a, b], output: existing, quality: 'source' }, () => {});
  assert.deepStrictEqual([r1.ok, r1.reason], [false, '同じ名前のファイルがあります']);
  assert.strictEqual(read(existing), 'keep');

  const raced = path.join(dest, 'raced.mp4');
  Object.assign(process.env, { FAKE_FF_TOUCH: raced, FAKE_FF_TOUCH_AT: '1' });
  const r2 = await media.mergeVideos(job(), { inputs: [a, b], output: raced, quality: 'source' }, () => {});
  assert.deepStrictEqual([r2.ok, r2.reason], [false, '同じ名前のファイルがあります']);
  assert.strictEqual(read(raced), 'other app');

  process.env.FAKE_FF_FAIL_AT = '2';
  const failed = path.join(dest, 'failed.mp4');
  const r3 = await media.mergeVideos(job(), { inputs: [a, b], output: failed, quality: 'source' }, () => {});
  assert.strictEqual(r3.ok, false);
  assert.deepStrictEqual(listAll(dest), ['a.mp4', 'b.mp4', 'existing.mp4', 'raced.mp4']);
  assert.deepStrictEqual([read(a), read(b)], ['A', 'B']);
});

test('動画を結合：読み取れない動画は名前を出して止める。調べている途中の中止で ffmpeg も止める', async () => {
  const dest = setup('join-probe', { FAKE_FF_PROBE: 'garbage' });
  const a = path.join(dest, 'a.mp4');
  fs.writeFileSync(a, 'A');
  const output = path.join(dest, 'out.mp4');
  const r1 = await media.mergeVideos(new media.Job(), { inputs: [a, a], output, quality: 'source' }, () => {});
  assert.deepStrictEqual([r1.ok, r1.reason], [false, 'a.mp4 を読み込めません']);

  process.env.FAKE_FF_PROBE = 'hang';
  const job = new media.Job();
  const running = media.mergeVideos(job, { inputs: [a, a], output, quality: 'source' }, () => {});
  await waitFor(() => fs.existsSync(process.env.FAKE_FF_PIDFILE) && read(process.env.FAKE_FF_PIDFILE).split('\n').filter(Boolean).length >= 2);
  job.cancel();
  const r2 = await running;
  assert.deepStrictEqual([r2.ok, r2.cancelled], [false, true]);
  assertNoChildren(process.env.FAKE_FF_PIDFILE);
  assert.deepStrictEqual(listAll(dest), ['a.mp4']);
});
