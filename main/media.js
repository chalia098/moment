// ffmpeg を使った動画の切り出し・結合と、動画を調べる処理。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const core = require('../src/lib/core.js');

// ---------- ffmpeg の場所 ----------
let ffmpegPath = null;
function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const candidates = [];
  try {
    const p = require('ffmpeg-static');
    if (p) candidates.push(String(p).replace('app.asar', 'app.asar.unpacked'));
  } catch { /* 同梱されていなければ、Mac に入っている ffmpeg を探す */ }
  if (process.env.MOMENT_FFMPEG) candidates.unshift(process.env.MOMENT_FFMPEG);
  candidates.push(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) { ffmpegPath = c; return c; } } catch { /* 次を試す */ }
  }
  return null;
}

// ---------- ffmpeg を短く動かして結果を受け取る（調べる用） ----------
const PROBE_TIMEOUT_MS = 30000; // 動画を調べる
const ENCODERS_TIMEOUT_MS = 15000; // 書き出し方式の確認
const CAPTURE_MAX_BYTES = 1024 * 1024; // 受け取る出力の上限
const KILL_GRACE_MS = 2000; // 止めてから終わるのを待つ長さ
const CANCELLED = { ok: false, error: 'cancelled', reason: '中止しました' };

// 時間切れ・起動失敗・出力の上限を見張りながら ffmpeg を動かす。画面を止めないよう非同期で、止めた ffmpeg は残さない。
// → {ok:true, stdout, stderr} | {ok:false, error:'spawn'|'timeout'|'cancelled', reason}
function capture(args, { timeoutMs, maxBytes = CAPTURE_MAX_BYTES, job = null, timeoutReason }) {
  return new Promise(resolve => {
    const ff = resolveFfmpeg();
    if (!ff) return resolve({ ok: false, error: 'spawn', reason: 'ffmpeg が見つかりません' });
    if (job && job.cancelled) return resolve({ ...CANCELLED });
    let child;
    try {
      child = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ok: false, error: 'spawn', reason: 'ffmpeg を起動できません' });
    }
    const untrack = job ? job.track(child) : () => {};
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let grace = null;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* もう終わっている */ } };
    const timeoutResult = { ok: false, error: 'timeout', reason: timeoutReason };
    const spawnFailed = { ok: false, error: 'spawn', reason: 'ffmpeg を起動できません' };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      untrack();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      // 止めたのに終わらない場合も、いつまでも待たない
      grace = setTimeout(() => finish(timeoutResult), KILL_GRACE_MS);
    }, timeoutMs);
    const take = key => chunk => {
      const room = maxBytes - bytes;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks[key].push(part);
      bytes += part.length;
      if (bytes >= maxBytes) kill(); // 上限に届いたら止めて、受け取った分だけで読む
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    // 起動できなかったとき（見つからない・実行できない）は close が来ないことがある
    child.on('error', () => { if (child.pid === undefined) finish(spawnFailed); });
    child.on('close', () => {
      if (child.pid === undefined) return finish(spawnFailed);
      if (job && job.cancelled) return finish({ ...CANCELLED });
      if (timedOut) return finish(timeoutResult);
      finish({ ok: true, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

// 使える H.264 の書き出し方式を ffmpeg に聞く。うまくいったときだけ覚えておき、失敗したら次にやり直す。
let encoderCache = null;
async function videoEncoderArgs(opts = {}) {
  if (encoderCache) return encoderCache;
  const r = await capture(['-hide_banner', '-encoders'], {
    timeoutMs: opts.timeoutMs || ENCODERS_TIMEOUT_MS, job: opts.job, timeoutReason: 'ffmpeg の確認に時間がかかりすぎました'
  });
  if (!r.ok) {
    const err = new Error(r.reason);
    err.cancelled = r.error === 'cancelled';
    throw err;
  }
  const out = r.stdout;
  if (/\blibx264\b/.test(out)) encoderCache = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  else if (/\bh264_videotoolbox\b/.test(out)) encoderCache = ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-pix_fmt', 'yuv420p'];
  else if (/Encoders:/.test(out)) encoderCache = ['-c:v', 'mpeg4', '-q:v', '2'];
  else return ['-c:v', 'mpeg4', '-q:v', '2']; // 一覧として読めないときは、覚えずに今回だけ使う
  return encoderCache;
}
const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '192k'];

function qualityFilter(quality) {
  if (quality === '1080p') return "scale=-2:'min(1080,ih)'";
  if (quality === '720p') return "scale=-2:'min(720,ih)'";
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
}

// ---------- 調べる ----------
// 動画の長さ・映像・音声を調べる。
// → {ok:true, duration, video, audio} | {ok:false, error:'spawn'|'timeout'|'parse'|'cancelled', reason, ...}
async function probe(file, opts = {}) {
  const r = await capture(['-hide_banner', '-i', file], {
    timeoutMs: opts.timeoutMs || PROBE_TIMEOUT_MS, maxBytes: opts.maxBytes, job: opts.job, timeoutReason: '動画を調べるのに時間がかかりすぎました'
  });
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason, duration: null, video: null, audio: null };
  const info = parseProbe(r.stderr);
  return info.ok ? info : { ...info, error: 'parse', reason: 'この形式の動画は開けません' };
}

function parseProbe(err) {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null;
  const vLine = (err.split('\n').find(l => /Stream #.*Video:/.test(l)) || '');
  const aLine = (err.split('\n').find(l => /Stream #.*Audio:/.test(l)) || '');
  const video = vLine ? {
    codec: (/Video: (\w+)/.exec(vLine) || [])[1],
    width: +((/, (\d{2,5})x(\d{2,5})/.exec(vLine) || [])[1] || 0),
    height: +((/, (\d{2,5})x(\d{2,5})/.exec(vLine) || [])[2] || 0),
    fps: parseFloat((/([\d.]+) fps/.exec(vLine) || [])[1] || (/([\d.]+) tbr/.exec(vLine) || [])[1] || '0')
  } : null;
  const audio = aLine ? {
    codec: (/Audio: (\w+)/.exec(aLine) || [])[1],
    rate: +((/(\d+) Hz/.exec(aLine) || [])[1] || 0),
    channels: ((/Hz, ([^,]+)/.exec(aLine) || [])[1] || '').trim()
  } : null;
  return { duration, video, audio, ok: !!video && duration != null };
}

// ---------- 実行 ----------
// 1つの処理（ダウンロード・結合）。中止すると、動いている ffmpeg（調べる途中のものも）を全部止める。
class Job {
  constructor() { this.children = new Set(); this.cancelled = false; }
  track(child) {
    this.children.add(child);
    return () => this.children.delete(child);
  }
  cancel() {
    this.cancelled = true;
    for (const child of this.children) { try { child.kill('SIGKILL'); } catch { /* もう終わっている */ } }
  }
}

function run(job, args, duration, onFraction) {
  return new Promise((resolve) => {
    const ff = resolveFfmpeg();
    if (!ff) return resolve({ ok: false, reason: 'ffmpeg が見つかりません' });
    if (job.cancelled) return resolve({ ok: false, cancelled: true, reason: '中止しました' });
    let child;
    try {
      child = spawn(ff, ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args]);
    } catch {
      return resolve({ ok: false, reason: 'ffmpeg を起動できません' });
    }
    const untrack = job.track(child);
    let errTail = '';
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0 && onFraction) onFraction(Math.min(1, (+m[1] / 1e6) / duration));
      }
      if (buf.length > 65536) buf = ''; // 改行のない出力をためこまない
    });
    child.stderr.on('data', chunk => { errTail = (errTail + chunk.toString()).slice(-4000); });
    child.on('error', () => {
      if (child.pid === undefined) { untrack(); resolve({ ok: false, reason: 'ffmpeg を起動できません' }); }
    });
    child.on('close', code => {
      untrack();
      if (job.cancelled) return resolve({ ok: false, cancelled: true, reason: '中止しました' });
      resolve(code === 0 ? { ok: true } : { ok: false, reason: explain(errTail) });
    });
  });
}

function explain(stderr) {
  if (/Permission denied|Operation not permitted/i.test(stderr)) return '保存先に書き込めません';
  if (/No space left/i.test(stderr)) return '空き容量が足りません';
  if (/already exists/i.test(stderr)) return '同じ名前のファイルがあります';
  if (/No such file or directory/i.test(stderr)) return '元の動画が見つかりません';
  if (/Invalid data found/i.test(stderr)) return 'この動画は読み込めません';
  const lines = stderr.trim().split('\n').filter(Boolean);
  return `ダウンロードに失敗しました（${(lines[lines.length - 1] || '').slice(0, 160)}）`;
}

// ---------- 既存のファイルを守る書き出し ----------
function fsReason(err) {
  const code = err && err.code;
  if (code === 'EEXIST') return '同じ名前のファイルがあります';
  if (code === 'ENOSPC' || code === 'EDQUOT') return '空き容量が足りません';
  if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(code)) return '保存先に書き込めません';
  return `ダウンロードに失敗しました（${code || (err && err.message) || ''}）`;
}

async function exists(p) {
  return fsp.lstat(p).then(() => true, () => false);
}

// 保存先の中に試合名のフォルダを新しく作る。同じ名前があれば「〜 2」。既存のフォルダの中には書かない。
async function newDir(parent, name) {
  await fsp.mkdir(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = path.join(parent, n === 1 ? name : `${name} ${n}`);
    try {
      await fsp.mkdir(dir); // 新しく作れたときだけ使う（あれば EEXIST）
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
}

// その処理だけが使う作業用の隠しフォルダ。最終の保存先と同じ場所に作るので、最後は名前を付けるだけで済む。
function makeWorkDir(parent) {
  return fsp.mkdtemp(path.join(parent, '.moment-'));
}

// できあがった一時ファイルを、最終の名前で置く。同じ名前のファイルがあれば置かない（上書きしない）。
// 確かめてから置くまでの間にほかのアプリが同じ名前を作っても、link と 'wx' が EEXIST で止まる。
async function placeNew(tmp, final) {
  try {
    await fsp.link(tmp, final);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, reason: fsReason(err) };
    // ハードリンクを作れない保存先（exFAT など）では、新しく作ったファイルに写す
  }
  let out;
  try {
    out = await fsp.open(final, 'wx');
  } catch (err) {
    return { ok: false, reason: fsReason(err) };
  }
  // ここから先の final はこの処理が作ったもの。写せなかったら消してよい
  try {
    await pipeline(fs.createReadStream(tmp), out.createWriteStream());
    return { ok: true };
  } catch (err) {
    await out.close().catch(() => {});
    await fsp.rm(final, { force: true }).catch(() => {});
    return { ok: false, reason: fsReason(err) };
  }
}

function concatList(parts) {
  return parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
}

function cutArgs(input, start, end, quality, enc, out) {
  return [
    '-ss', start.toFixed(3), '-i', input, '-t', Math.max(0.05, end - start).toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', qualityFilter(quality), ...enc, ...AUDIO_ARGS,
    '-movflags', '+faststart', '-n', out
  ];
}

// ---------- シーンの書き出し ----------
// opts: {input, dest, gameName, quality, mode:'separate'|'merged', mergedTitle, items:[{id,title,start,end}]}
async function exportScenes(job, opts, emit) {
  const items = opts.items.slice().sort((a, b) => a.start - b.start);
  let enc;
  try {
    enc = await videoEncoderArgs({ job });
  } catch (err) {
    if (err.cancelled) return { dir: null, results: [], cancelled: true };
    throw err;
  }
  let dir = null;
  let work;
  try {
    dir = await newDir(opts.dest, core.sanitizeFileName(opts.gameName || 'Moment'));
    work = await makeWorkDir(dir);
  } catch (err) {
    if (dir) await fsp.rmdir(dir).catch(() => {}); // この処理が作った空のフォルダだけ
    throw new Error(fsReason(err));
  }
  try {
    const run1 = opts.mode === 'merged' ? exportMerged : exportSeparate;
    return await run1(job, opts, items, dir, work, enc, emit);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function exportMerged(job, opts, items, dir, work, enc, emit) {
  const total = items.reduce((s, it) => s + (it.end - it.start), 0) || 1;
  let doneSec = 0;
  const results = [];
  const name = `${core.sanitizeFileName(opts.mergedTitle || opts.gameName || 'まとめ')}.mp4`;
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const part = path.join(work, `part-${String(i).padStart(4, '0')}.mp4`);
    emit({ type: 'progress', fraction: doneSec / total, done: i, total: items.length, current: name });
    const r = await run(job, cutArgs(opts.input, it.start, it.end, opts.quality, enc, part), it.end - it.start,
      f => emit({ type: 'progress', fraction: (doneSec + f * (it.end - it.start)) / total, done: i, total: items.length, current: name }));
    if (!r.ok) {
      results.push({ file: name, ok: false, reason: r.reason });
      emit({ type: 'item', file: name, ok: false, reason: r.reason });
      return { dir, results, cancelled: !!r.cancelled };
    }
    parts.push(part);
    doneSec += it.end - it.start;
  }
  const list = path.join(work, 'list.txt');
  await fsp.writeFile(list, concatList(parts), { flag: 'wx' });
  const tmp = path.join(work, 'merged.mp4');
  const r = await run(job, ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-n', tmp], 0, null);
  const placed = r.ok ? await placeNew(tmp, path.join(dir, name)) : r;
  results.push({ file: name, ok: placed.ok, reason: placed.ok ? null : placed.reason });
  emit({ type: 'item', file: name, ok: placed.ok, reason: placed.ok ? null : placed.reason });
  emit({ type: 'progress', fraction: 1, done: items.length, total: items.length });
  return { dir, results, cancelled: !!r.cancelled };
}

async function exportSeparate(job, opts, items, dir, work, enc, emit) {
  const total = items.reduce((s, it) => s + (it.end - it.start), 0) || 1;
  let doneSec = 0;
  const results = [];
  const names = core.planFileNames(items);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const name = names.get(it.id);
    const tmp = path.join(work, `${String(i).padStart(4, '0')}.mp4`);
    emit({ type: 'progress', fraction: doneSec / total, done: i, total: items.length, current: name });
    const r = await run(job, cutArgs(opts.input, it.start, it.end, opts.quality, enc, tmp), it.end - it.start,
      f => emit({ type: 'progress', fraction: (doneSec + f * (it.end - it.start)) / total, done: i, total: items.length, current: name }));
    doneSec += it.end - it.start;
    if (r.cancelled) return { dir, results, cancelled: true };
    const placed = r.ok ? await placeNew(tmp, path.join(dir, name)) : r;
    await fsp.rm(tmp, { force: true }).catch(() => {}); // この処理の一時ファイル
    results.push({ id: it.id, file: name, ok: placed.ok, reason: placed.ok ? null : placed.reason });
    emit({ type: 'item', id: it.id, file: name, ok: placed.ok, reason: placed.ok ? null : placed.reason });
  }
  emit({ type: 'progress', fraction: 1, done: items.length, total: items.length });
  return { dir, results, cancelled: false };
}

// ---------- 動画の結合 ----------
function sameFormat(a, b) {
  if (!a.video || !b.video) return false;
  const v = a.video.codec === b.video.codec && a.video.width === b.video.width && a.video.height === b.video.height
    && Math.abs((a.video.fps || 0) - (b.video.fps || 0)) < 0.02;
  const au = (!a.audio && !b.audio) || (a.audio && b.audio && a.audio.codec === b.audio.codec
    && a.audio.rate === b.audio.rate && a.audio.channels === b.audio.channels);
  return v && au;
}

// opts: {inputs:[path], output, quality:'source'|'1080p'|'720p'}
async function mergeVideos(job, opts, emit) {
  const infos = [];
  for (const p of opts.inputs) {
    const info = await probe(p, { job });
    if (info.error === 'cancelled') return { ok: false, cancelled: true, reason: info.reason };
    if (!info.ok) return { ok: false, reason: info.error === 'parse' ? `${path.basename(p)} を読み込めません` : info.reason };
    infos.push({ path: p, ...info });
  }
  if (opts.quality === 'source' && !infos.every(i => sameFormat(infos[0], i))) {
    return { ok: false, code: 'incompatible', reason: '元のままでは結合できません。1080p か 720p を選んでください' };
  }
  // 早めに知らせる。最後に置くときも上書きしない
  if (await exists(opts.output)) return { ok: false, reason: '同じ名前のファイルがあります' };
  let enc = null;
  if (opts.quality !== 'source') {
    try {
      enc = await videoEncoderArgs({ job });
    } catch (err) {
      return { ok: false, cancelled: !!err.cancelled, reason: err.message };
    }
  }
  let work;
  try {
    work = await makeWorkDir(path.dirname(opts.output));
  } catch (err) {
    return { ok: false, reason: fsReason(err) };
  }
  const total = infos.reduce((s, i) => s + (i.duration || 0), 0) || 1;
  try {
    let parts;
    let doneSec = 0;
    if (opts.quality === 'source') {
      parts = infos.map(i => i.path);
    } else {
      const H = opts.quality === '720p' ? 720 : 1080;
      const W = opts.quality === '720p' ? 1280 : 1920;
      const fps = Math.round((infos[0].video.fps || 30) * 1000) / 1000;
      parts = [];
      for (let k = 0; k < infos.length; k++) {
        const info = infos[k];
        const part = path.join(work, `part-${k}.mp4`);
        const args = ['-i', info.path];
        if (!info.audio) args.push('-f', 'lavfi', '-t', String(info.duration), '-i', 'anullsrc=r=48000:cl=stereo');
        args.push(
          '-map', '0:v:0', '-map', info.audio ? '0:a:0' : '1:a:0', '-sn', '-dn',
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
          '-r', String(fps), ...enc, ...AUDIO_ARGS, '-ar', '48000', '-ac', '2', '-shortest', '-n', part);
        const r = await run(job, args, info.duration, f => emit({ type: 'progress', fraction: (doneSec + f * info.duration) / total }));
        if (!r.ok) return { ok: false, cancelled: !!r.cancelled, reason: r.reason };
        doneSec += info.duration;
        parts.push(part);
      }
    }
    const list = path.join(work, 'list.txt');
    await fsp.writeFile(list, concatList(parts), { flag: 'wx' });
    const tmp = path.join(work, `merged${path.extname(opts.output) || '.mp4'}`);
    const copyDur = opts.quality === 'source' ? total : 0;
    const r = await run(job, ['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-n', tmp],
      copyDur, f => emit({ type: 'progress', fraction: f }));
    if (!r.ok) return { ok: false, cancelled: !!r.cancelled, reason: r.reason };
    const placed = await placeNew(tmp, opts.output);
    if (!placed.ok) return { ok: false, reason: placed.reason };
    emit({ type: 'progress', fraction: 1 });
    return { ok: true, output: opts.output };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { resolveFfmpeg, probe, videoEncoderArgs, Job, exportScenes, mergeVideos, sameFormat };
