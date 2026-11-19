const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('在线静态构建包含完整浏览器生成链路且不依赖本地 API', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-online.cjs')], { cwd: root });
  const required = [
    'index.html', 'app.js', 'styles.css', '.nojekyll', 'assets/base.pptx', 'examples/outline.md',
    'engine/engine.js', 'engine/parser.js',
    'engine/layout.js', 'engine/zip.js', 'engine/pptx.js',
  ];
  for (const name of required) assert.ok(fs.statSync(path.join(root, 'dist', name)).isFile(), name);
  const app = fs.readFileSync(path.join(root, 'dist', 'app.js'), 'utf8');
  assert.match(app, /import \{ generateDeck \} from '\.\/engine\/engine\.js'/);
  assert.match(app, /fetch\('\.\/examples\/outline\.md'\)/);
  assert.match(app, /URL\.createObjectURL/);
  assert.doesNotMatch(app, /\/api\/generate|pollJob|启动网页版|new Worker/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'engine', 'generator.worker.js')), false);
  const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.doesNotMatch(html, /(?:src|href)="\/(?:app\.js|styles\.css|assets\/|examples\/)/);
  assert.match(html, /在线使用 · 无需安装 · 文件仅在浏览器处理/);
  const shell = fs.readFileSync(path.join(root, 'dist', 'assets', 'base.pptx'));
  assert.equal(shell.subarray(0, 2).toString(), 'PK');
});
