// Moment.app を作る（自分のMac用）。
// npm install で入った Electron をもとに、アプリの中身・アイコン・ffmpeg を入れて、
// Mac に標準で入っている codesign でその場の署名（ad-hoc）をする。Apple の署名ではない。
// 使い方：npm run dist → dist/Moment.app ができる
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const APP_ID = 'app.moment.electron';

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (process.platform !== 'darwin' && !process.env.MOMENT_BUILD_ANYWHERE) fail('このコマンドは Mac で実行してください。');

const electronApp = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const ffmpegDir = path.join(ROOT, 'node_modules', 'ffmpeg-static');
if (!fs.existsSync(electronApp)) fail('Electron が見つかりません。先に npm install を実行してください。');
if (!fs.existsSync(path.join(ffmpegDir, 'ffmpeg'))) fail('ffmpeg が見つかりません。先に npm install を実行してください。');

const outDir = path.join(ROOT, 'dist');
const app = path.join(outDir, 'Moment.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const appDir = path.join(resources, 'app');

console.log('1/5 Electron をコピーしています…');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(electronApp, app, { recursive: true, verbatimSymlinks: true });
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });

console.log('2/5 Moment の中身を入れています…');
const copy = rel => fs.cpSync(path.join(ROOT, rel), path.join(appDir, rel), { recursive: true });
copy('package.json');
copy('main');
copy('src');
copy(path.join('build', 'icon.png'));

console.log('3/5 ffmpeg を入れています…');
const ffOut = path.join(appDir, 'node_modules', 'ffmpeg-static');
fs.mkdirSync(ffOut, { recursive: true });
for (const f of ['index.js', 'package.json', 'ffmpeg', 'LICENSE', 'ffmpeg.LICENSE', 'ffmpeg.README']) {
  const src = path.join(ffmpegDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ffOut, f));
}
fs.chmodSync(path.join(ffOut, 'ffmpeg'), 0o755);

console.log('4/5 アイコンと名前を設定しています…');
fs.copyFileSync(path.join(ROOT, 'build', 'icon.icns'), path.join(resources, 'electron.icns'));
const plist = path.join(contents, 'Info.plist');
const setPlist = (key, value) => execFileSync('plutil', ['-replace', key, '-string', value, plist]);
setPlist('CFBundleName', 'Moment');
setPlist('CFBundleDisplayName', 'Moment');
setPlist('CFBundleIdentifier', APP_ID);
setPlist('CFBundleShortVersionString', pkg.version);
setPlist('CFBundleVersion', pkg.version);

console.log('5/5 署名しています…');
execFileSync('xattr', ['-cr', app]);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

console.log(`\nできました：${path.relative(ROOT, app)}\nFinder で dist フォルダを開き、Moment をアプリケーションフォルダにドラッグしてください。\n`);
