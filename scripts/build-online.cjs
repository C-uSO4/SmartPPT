const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'web');
const output = path.join(root, 'dist');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, '.nojekyll'), '');
for (const name of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(source, name), path.join(output, name));
}
for (const name of ['assets', 'examples']) {
  fs.cpSync(path.join(source, name), path.join(output, name), { recursive: true });
}
fs.mkdirSync(path.join(output, 'engine'));
for (const name of ['engine.js', 'parser.js', 'layout.js', 'zip.js', 'pptx.js']) {
  fs.copyFileSync(path.join(source, 'engine', name), path.join(output, 'engine', name));
}
console.log(`在线静态站点已生成：${output}`);
