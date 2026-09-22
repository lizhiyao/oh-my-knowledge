/**
 * 解析 run-audit.sh 的取证目录，打印每页每视口的实测结论。
 * 用法：node design/studio/audit-summary.mjs <取证目录>
 * 只读输入目录，不写文件；结果由人工摘录进 spec.md。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('用法：node design/studio/audit-summary.mjs <取证目录>');
  process.exit(1);
}

function unescape(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseReport(html) {
  const match = html.match(/<pre[^>]*id="audit-report"[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) return null;
  try {
    return JSON.parse(unescape(match[1]));
  } catch {
    return null;
  }
}

const rows = [];
const contrastFails = new Map();

for (const viewport of await readdir(root)) {
  const specRoot = join(root, viewport);
  let specs = [];
  try {
    specs = await readdir(specRoot);
  } catch {
    continue;
  }
  for (const spec of specs) {
    let pages = [];
    try {
      pages = await readdir(join(specRoot, spec));
    } catch {
      continue;
    }
    for (const file of pages) {
      const html = await readFile(join(specRoot, spec, file), 'utf8');
      const report = parseReport(html);
      const page = file.replace(/\.dom\.html$/, '');
      if (!report) {
        rows.push({ viewport, spec, page, note: '未产出自测报告（页面缺 audit 钩子或脚本未执行）' });
        continue;
      }
      for (const fail of report.contrast.filter((item) => !item.pass && !item.exempt)) {
        const key = `${spec} ${fail.element} ${fail.text} ${fail.fontSize}px`;
        const previous = contrastFails.get(key);
        if (!previous || fail.ratio < previous.ratio) contrastFails.set(key, { ...fail, key });
      }
      rows.push({
        viewport,
        spec,
        page,
        note: [
          report.verdict.pageScrollClean ? '页面级无溢出' : `页面级溢出 x${report.scroll.documentOverflowX} y${report.scroll.documentOverflowY}`,
          report.verdict.clippedRegions.length ? `裁切区:${report.verdict.clippedRegions.join(',')}` : '无裁切区',
          `对比度未达 ${report.verdict.contrastFails.length}（豁免 ${report.verdict.contrastExempt}）`,
          `省略无出口 ${report.verdict.truncationFails.length}`,
          `焦点元素 ${report.focus.count}`,
        ].join(' · '),
      });
    }
  }
}

console.log('| 视口 | 规范档 | 页面 | 实测结论 |');
console.log('| --- | --- | --- | --- |');
for (const row of rows) {
  console.log(`| ${row.viewport} | ${row.spec} | ${row.page} | ${row.note} |`);
}

console.log('\n未达 WCAG AA 的文字对（按规范档分列，取各视口中最低值；豁免项不计入）：');
console.log('| 规范档 | 元素 | 文字 | 字号 | 实测对比度 | 需要 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const fail of [...contrastFails.values()].sort((a, b) => a.ratio - b.ratio)) {
  const [spec, ...rest] = fail.key.split(' ');
  console.log(`| ${spec} | ${rest.join(' ')} | ${fail.text} | ${fail.fontSize} | ${fail.ratio} | ${fail.required} |`);
}
if (contrastFails.size === 0) console.log('| — | 本轮无未达项 | | | | |');
