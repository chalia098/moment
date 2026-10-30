// 設定と作業ログの保存、動画の指紋。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const core = require('../src/lib/core.js');
const worklog = require('./worklog');

const CHUNK = 1024 * 1024; // 指紋に使う1か所あたりの大きさ（1MB）

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.logDir = path.join(baseDir, 'worklogs');
    this.settingsFile = path.join(baseDir, 'settings.json');
    this.windowFile = path.join(baseDir, 'window.json');
    this.writing = new Map(); // 保存先ごとの書き込みの列（最後に受け付けた書き込み）
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  // ---------- 書き込み ----------
  // 同じ保存先への書き込みは、受け付けた順に1件ずつ行う。中身は受け付けた時点で文字にして固定する。
  writeJson(file, data) {
    const text = JSON.stringify(data, null, 2);
    const prev = this.writing.get(file) || Promise.resolve();
    const done = prev.then(() => this.replaceFile(file, text));
    const tail = done.catch(() => {}); // 1回失敗しても、次の書き込みは続ける
    this.writing.set(file, tail);
    tail.then(() => { if (this.writing.get(file) === tail) this.writing.delete(file); });
    return done;
  }

  // 途中で落ちても壊れないよう、ほかと重ならない一時ファイルを新しく作って書き、書き終えてから置き換える
  async replaceFile(file, text) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fh = await fsp.open(tmp, 'wx'); // 新しく作れたときだけ書く（ほかの一時ファイルを横取りしない）
    try {
      try { await fh.writeFile(text, 'utf8'); } finally { await fh.close(); }
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {}); // この書き込みが作った一時ファイルだけ消す
      throw err;
    }
  }

  // 受け付けた書き込みが全部終わるまで待つ（アプリを終了するとき）
  async idle() {
    while (this.writing.size) await Promise.all([...this.writing.values()]);
  }

  readJsonSync(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  // ---------- 設定 ----------
  loadSettings() {
    const saved = this.readJsonSync(this.settingsFile);
    const base = core.defaultSettings();
    if (!saved) return base;
    return {
      ...base,
      ...saved,
      baseKeys: { ...base.baseKeys, ...(saved.baseKeys || {}) },
      shortcuts: Array.isArray(saved.shortcuts) ? saved.shortcuts : base.shortcuts,
      deletedShortcuts: Array.isArray(saved.deletedShortcuts) ? saved.deletedShortcuts : []
    };
  }

  async saveSettings(settings) {
    await this.writeJson(this.settingsFile, settings);
  }

  loadWindowState() { return this.readJsonSync(this.windowFile); }
  saveWindowStateSync(state) {
    try { fs.writeFileSync(this.windowFile, JSON.stringify(state)); } catch { /* 次回は既定の大きさで開く */ }
  }

  // ---------- 作業ログ ----------
  logPath(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('invalid id');
    return path.join(this.logDir, `${id}.json`);
  }

  async listLogs() {
    const names = await fsp.readdir(this.logDir).catch(() => []);
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const log = this.readJsonSync(path.join(this.logDir, n));
      if (!log || !log.id) continue;
      out.push({
        id: log.id,
        gameName: log.gameName,
        teamA: log.teamA,
        teamB: log.teamB,
        sceneCount: (log.scenes || []).length,
        updatedAt: log.updatedAt,
        videoFileName: log.video && log.video.fileName
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // 中身が正しくない作業ログは開かない（null）。なくてもよい項目は初期値で補う
  async getLog(id) {
    const raw = this.readJsonSync(this.logPath(id));
    if (!raw) return null;
    try { return worklog.checkLog(raw); } catch { return null; }
  }

  async findLogByFingerprint(fp) {
    const names = await fsp.readdir(this.logDir).catch(() => []);
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const raw = this.readJsonSync(path.join(this.logDir, n));
      if (!raw || !raw.video || raw.video.fingerprint !== fp) continue;
      try { return worklog.checkLog(raw); } catch { /* 正しくない作業ログは使わない */ }
    }
    return null;
  }

  // 確かめた項目だけで作り直して保存する。正しくなければ LogError を投げ、何も書かない。
  // 受け付けた順を守るため、書き込みを受け付けるまで await しない
  async saveLog(input) {
    const log = worklog.checkLog(input);
    log.updatedAt = new Date().toISOString();
    await this.writeJson(this.logPath(log.id), log);
    return log.updatedAt;
  }

  async deleteLog(id) {
    await fsp.rm(this.logPath(id), { force: true });
  }

  newLog({ gameName, teamA, teamB, video }) {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      gameName: gameName || '',
      teamA: teamA || '',
      teamB: teamB || '',
      video,
      lastPosition: 0,
      nextSeq: 1,
      scenes: [],
      shortcutNames: {}
    };
  }

  // 別のパソコンから持ってきた作業ログのファイルを読み、中身を確かめる。
  // 正しくなければ LogError（理由つき）を投げ、何も書き換えない
  async readImport(filePath) {
    const text = await readLimited(filePath, worklog.LIMITS.fileBytes);
    if (text == null) throw new worklog.LogError(`ファイルが大きすぎます（${worklog.LIMITS.fileBytes / 1024 / 1024}MBまで）`);
    let data;
    try { data = JSON.parse(text); } catch { throw new worklog.LogError('JSON として読めません'); }
    return this.importLog(data);
  }

  async importLog(data) {
    const log = worklog.checkImport(data, () => crypto.randomUUID());
    const exists = fs.existsSync(this.logPath(log.id));
    return { log, exists };
  }
}

// 上限を超えるファイルは途中で読むのをやめて null（大きなファイルを全部読み込まない）
async function readLimited(filePath, limit) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(CHUNK);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) return null;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}

// ---------- 指紋 ----------
// ファイルサイズ＋先頭・真ん中・末尾の1MBずつから作る。名前や場所が変わっても同じになる。
async function fingerprint(filePath) {
  const stat = await fsp.stat(filePath);
  const size = stat.size;
  const fh = await fsp.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    hash.update(`moment-v1|${size}|`);
    const offsets = size <= CHUNK * 3 ? [0] : [0, Math.floor(size / 2) - CHUNK / 2, size - CHUNK];
    for (const off of offsets) {
      const len = Math.min(size <= CHUNK * 3 ? size : CHUNK, size - off);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, off);
      hash.update(buf);
    }
    return { fingerprint: hash.digest('hex').slice(0, 40), size };
  } finally {
    await fh.close();
  }
}

module.exports = { Store, fingerprint };
