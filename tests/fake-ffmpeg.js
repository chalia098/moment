// テスト用の偽の ffmpeg。本物の動画は使わず、動きは環境変数で決める。
//   FAKE_FF_STATE     書き出し（-progress つき）の呼ばれた回数を数えるファイル
//   FAKE_FF_PIDFILE   起動するたびに自分のプロセス番号を書き足すファイル
//   FAKE_FF_PROBE     調べるとき：ok（初期）/ hang（止まる）/ garbage（読めない出力）/ flood（出力が止まらない）
//   FAKE_FF_ENCODERS  書き出し方式の確認：ok（初期）/ hang
//   FAKE_FF_FAIL_AT   n 回目の書き出しを失敗させる（例：2 / 1,3）
//   FAKE_FF_HANG_AT   n 回目の書き出しで止まる
//   FAKE_FF_TOUCH     FAKE_FF_TOUCH_AT 回目の書き出しの途中で、ほかのアプリのふりをしてこのファイルを作る
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const env = process.env;

function hang() { setInterval(() => {}, 1000); }
function listed(name) { return (env[name] || '').split(',').filter(Boolean).map(Number); }

function count() {
  const f = env.FAKE_FF_STATE;
  if (!f) return 1;
  const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
  fs.writeFileSync(f, String(n));
  return n;
}

function probe() {
  const mode = env.FAKE_FF_PROBE || 'ok';
  if (mode === 'hang') return hang();
  if (mode === 'garbage') {
    process.stderr.write('something went wrong\n');
    process.exitCode = 1;
    return;
  }
  process.stderr.write("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':\n"
    + `  Duration: ${env.FAKE_FF_DURATION || '00:01:40.50'}, start: 0.000000, bitrate: 1000 kb/s\n`
    + '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 5000 kb/s, 29.97 fps, 29.97 tbr\n'
    + '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s\n');
  if (mode === 'flood') {
    const junk = `${'x'.repeat(64 * 1024)}\n`;
    const pump = () => {
      while (process.stderr.write(junk)) { /* 止められるまで出し続ける */ }
      process.stderr.once('drain', pump);
    };
    return pump();
  }
  process.stderr.write('At least one output file must be specified\n');
  process.exitCode = 1;
}

function encode() {
  const n = count();
  const out = args[args.length - 1];
  if (args.includes('-n') && fs.existsSync(out)) {
    process.stderr.write(`File '${out}' already exists. Exiting.\n`);
    process.exitCode = 1;
    return;
  }
  const input = args[args.indexOf('-i') + 1];
  const body = args.includes('concat')
    ? fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
      .map(line => fs.readFileSync(line.replace(/^file '/, '').replace(/'$/, '').replace(/'\\''/g, "'"), 'utf8')).join('')
    : `cut:${n};`;
  fs.writeFileSync(out, 'partial');
  if (env.FAKE_FF_TOUCH && listed('FAKE_FF_TOUCH_AT').includes(n)) fs.writeFileSync(env.FAKE_FF_TOUCH, 'other app');
  if (listed('FAKE_FF_HANG_AT').includes(n)) return hang();
  if (listed('FAKE_FF_FAIL_AT').includes(n)) {
    process.stderr.write('Invalid data found when processing input\n');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(out, body);
  process.stdout.write('out_time_us=1000000\nprogress=end\n');
}

if (env.FAKE_FF_PIDFILE) fs.appendFileSync(env.FAKE_FF_PIDFILE, `${process.pid}\n`);
if (args.includes('-encoders')) {
  if (env.FAKE_FF_ENCODERS === 'hang') hang();
  else process.stdout.write('Encoders:\n V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC\n');
} else if (args.includes('-progress')) {
  encode();
} else {
  probe();
}
