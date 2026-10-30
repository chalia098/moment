// テストの道具。一時フォルダは tests/ の中に作り（ほかのフォルダには触れない）、テストの終わりに消す。
const fs = require('fs');
const path = require('path');

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(__dirname, '.tmp-'));
}

function removeTmpRoot(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 偽の ffmpeg（fake-ffmpeg.js）を、実行できるファイルとして dir に置く
function fakeFfmpeg(dir) {
  const wrapper = path.join(dir, 'ffmpeg');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-ffmpeg.js')}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

// 正しい作業ログの例（呼ぶたびに新しく作る）
function validLog() {
  return {
    version: 1,
    id: 'log-1',
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    gameName: '日本選手権予選',
    teamA: '順天堂',
    teamB: '渡辺組',
    video: { fingerprint: 'f'.repeat(40), fileName: 'game.mp4', lastPath: '/videos/game.mp4', size: 1000, duration: 3600 },
    lastPosition: 12.5,
    nextSeq: 3,
    scenes: [
      { id: 's-1', seq: 1, start: 10, end: 20, tags: ['a-setof'], titleOverride: null, memo: '' },
      { id: 's-2', seq: 2, start: 30, end: 45.5, tags: ['b-fb', 'n-65'], titleOverride: '速攻', memo: 'メモ' }
    ],
    shortcutNames: {
      'a-setof': { name: 'setOF', team: 'A' },
      'b-fb': { name: 'FB', team: 'B' },
      'n-65': { name: '6:5', team: null }
    }
  };
}

// 条件がそろうまで待つ（テストの中だけで使う）
async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('待ちきれませんでした');
    await new Promise(r => setTimeout(r, 20));
  }
}

module.exports = { makeTmpRoot, removeTmpRoot, fakeFfmpeg, validLog, waitFor };
