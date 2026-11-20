import { readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const target = new URL('../AI智能证据联动-交互原型-可交付版.html', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const scriptTag = html.match(/<script\b[^>]*\bsrc="\/([^"]+)"[^>]*><\/script>/);
const styleTag = html.match(/<link\b(?=[^>]*rel="stylesheet")[^>]*\bhref="\/([^"]+)"[^>]*>/);
const root = '<div id="root"></div>';
if (!scriptTag || !styleTag || !html.includes(root)) {
  throw new Error('构建产物缺少脚本、样式或 React 容器');
}
const [script, style] = await Promise.all([
  readFile(new URL(scriptTag[1], dist), 'utf8'),
  readFile(new URL(styleTag[1], dist), 'utf8'),
]);
const standalone = html.replace(scriptTag[0], '')
  .replace(styleTag[0], () => '<style>' + style + '</style>')
  .replace(root, () => root + '\n<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>');
await writeFile(target, standalone);
console.log('已生成可直接打开的独立 HTML');
