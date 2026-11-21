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
    'engine/layout.js', 'engine/zip.js', 'engine/pptx.js', 'engine/ai.js',
  ];
  for (const name of required) assert.ok(fs.statSync(path.join(root, 'dist', name)).isFile(), name);
  const app = fs.readFileSync(path.join(root, 'dist', 'app.js'), 'utf8');
  assert.match(app, /import \{ generateDeck \} from '\.\/engine\/engine\.js'/);
  assert.match(app, /fetch\('\.\/examples\/outline\.md'\)/);
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /templateBytes/);
  assert.match(app, /templateInput/);
  assert.match(app, /useAI: \$\('aiAssist'\)\.checked/);
  assert.match(app, /result\.fidelity\.page_map/);
  assert.match(app, /指定 PPT 页回读匹配/);
  assert.doesNotMatch(app, /\/api\/generate|pollJob|启动网页版|new Worker/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'engine', 'generator.worker.js')), false);
  const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.doesNotMatch(html, /(?:src|href)="\/(?:app\.js|styles\.css|assets\/|examples\/)/);
  assert.match(html, /在线使用 · 无需安装 · 默认本地处理/);
  assert.match(html, /id="templateInput" type="file" accept="\.pptx"/);
  assert.match(html, /id="aiAssist" type="checkbox"/);
  assert.match(html, /文字块会经本站云端代理发送至 DeepSeek/);
  assert.match(html, /<th>PPT 页码<\/th>/);
  const engine = fs.readFileSync(path.join(root, 'dist', 'engine', 'engine.js'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'dist', 'engine', 'parser.js'), 'utf8');
  const layout = fs.readFileSync(path.join(root, 'dist', 'engine', 'layout.js'), 'utf8');
  const pptx = fs.readFileSync(path.join(root, 'dist', 'engine', 'pptx.js'), 'utf8');
  assert.match(engine, /parseVisualTemplate/);
  assert.match(engine, /template_parse_seconds/);
  assert.match(engine, /auditPackage\(bytes, model, job\)/);
  assert.match(parser, /export async function parseVisualTemplate/);
  assert.match(parser, /slideLayout/);
  assert.match(parser, /slideMaster/);
  assert.match(parser, /collectDecorations/);
  assert.match(layout, /visualPage\.decorations/);
  assert.match(pptx, /page_map: Object\.fromEntries\(expectedPages\)/);
  const shell = fs.readFileSync(path.join(root, 'dist', 'assets', 'base.pptx'));
  assert.equal(shell.subarray(0, 2).toString(), 'PK');
  assert.ok(fs.statSync(path.join(root, 'api', 'analyze.js')).isFile());
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.buildCommand, 'node scripts/build-online.cjs');
  assert.equal(config.outputDirectory, 'dist');
});
