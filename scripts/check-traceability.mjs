#!/usr/bin/env node
/**
 * M0 追溯矩阵检查：
 *   node scripts/check-traceability.mjs [srs.md] [--out docs/追溯矩阵-M0.md]
 *
 * 规则：
 *  1. 定义：Markdown 表格首列出现的 BR/FR/AC/NFR/DC/AI 编号。
 *  2. 引用：正文中出现的所有编号（含 §8.6 的区间与斜杠简写）。
 *  3. 悬空：被引用但未定义的编号。
 *  4. 未引用：已定义但除定义行外从未出现的编号。
 *
 * 退出码：有悬空引用时 1，否则 0。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'docs', '追溯矩阵-M0.md');
const inputArg = args.find((a) => !a.startsWith('--') && a !== outFile);
const srsPath = inputArg ? path.resolve(inputArg) : path.join(root, 'docs', '需求规格说明书-合并版-M3E.md');

const text = fs.readFileSync(srsPath, 'utf8');
const lines = text.split(/\r?\n/);

const PREFIX = '(?:BR|FR|AC|NFR|DC|AI)';
const ID_RE = new RegExp(`\\b${PREFIX}(?:-[A-Z0-9]+(?:-[A-Z0-9]+)*)?-\\d{3}\\b`, 'g');
const RANGE_RE = new RegExp(
  `\\b(${PREFIX}(?:-[A-Z0-9]+(?:-[A-Z0-9]+)*)?)-(\\d{3})\\.\\.(\\d{3})\\b`,
  'g'
);
const SLASH_RE = new RegExp(`\\b(${PREFIX}(?:-[A-Z0-9]+(?:-[A-Z0-9]+)*)?-\\d{3})((?:/\\d{3})+)\\b`, 'g');

/** 展开 `FR-RENDER-001..006` 与 `FR-GEN-001/003` 这类简写 */
function expand(textValue) {
  let value = textValue.replace(RANGE_RE, (_, prefix, start, end) => {
    const a = Number(start);
    const b = Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > 200) return _;
    const out = [];
    for (let n = a; n <= b; n++) out.push(`${prefix}-${String(n).padStart(3, '0')}`);
    return out.join(' ');
  });
  value = value.replace(SLASH_RE, (_, full, rest) => {
    const m = /^(.*)-(\d{3})$/.exec(full);
    if (!m) return _;
    const out = [full];
    for (const part of rest.split('/').filter(Boolean)) out.push(`${m[1]}-${part}`);
    return out.join(' ');
  });
  return value;
}

const expanded = expand(text);
const allIds = new Set(expanded.match(ID_RE) ?? []);

const DEF_RE = new RegExp(`^\\|\\s*(${PREFIX}(?:-[A-Z0-9]+(?:-[A-Z0-9]+)*)?-\\d{3})\\s*\\|`);
const defined = new Map();
const definitionLines = new Set();

lines.forEach((line, index) => {
  const m = DEF_RE.exec(line);
  if (!m) return;
  const id = m[1];
  defined.set(id, { line: index + 1, text: line });
  definitionLines.add(index);
});

const referenced = new Map();
lines.forEach((line, index) => {
  if (definitionLines.has(index)) return;
  const ids = new Set(expand(line).match(ID_RE) ?? []);
  for (const id of ids) {
    if (!referenced.has(id)) referenced.set(id, []);
    referenced.get(id).push(index + 1);
  }
});

const dangling = [...allIds].filter((id) => !defined.has(id)).sort();
const unreferenced = [...defined.keys()].filter((id) => !referenced.has(id)).sort();

const groupOf = (id) => id.split('-')[0];
const definedByGroup = {};
for (const id of defined.keys()) {
  const g = groupOf(id);
  definedByGroup[g] = (definedByGroup[g] ?? 0) + 1;
}

const p0 = [];
const p0Fr = [];
for (const line of lines) {
  const m = DEF_RE.exec(line);
  if (m && /\|\s*P0\s*\|/.test(line)) {
    p0.push(m[1]);
    if (m[1].startsWith('FR-')) p0Fr.push(m[1]);
  }
}

/** 取某个二级标题到下一个二级标题之间的正文 */
function section(startTitle, endTitle) {
  const start = lines.findIndex((l) => l.trim() === startTitle);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.trim() === endTitle);
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

const traceText = expand(
  `${section('### 8.6 需求追溯', '### 8.7 测试基线')}\n${section('## 11. 实施里程碑', '## 12. 附录')}`
);
const traceIds = new Set(traceText.match(ID_RE) ?? []);
const p0FrMissing = p0Fr.filter((id) => !traceIds.has(id));
const p0Ac = p0.filter((id) => id.startsWith('AC-'));
const p0AcMissing = p0Ac.filter((id) => !traceIds.has(id));

const report = [];
report.push('# 追溯矩阵检查报告（M0）');
report.push('');
report.push(`- 检查对象：\`${path.relative(root, srsPath).replace(/\\/g, '/')}\``);
report.push(`- 生成时间：${new Date().toISOString()}`);
report.push(`- 定义编号：${defined.size}`);
report.push(`- 被引用编号：${referenced.size}`);
report.push(`- 悬空引用：${dangling.length}`);
report.push(`- 已定义但未被引用：${unreferenced.length}`);
report.push('');
report.push('## 1. 编号统计');
report.push('');
report.push('| 前缀 | 定义数 |');
report.push('| --- | --- |');
for (const [g, n] of Object.entries(definedByGroup).sort()) report.push(`| ${g} | ${n} |`);
report.push('');
report.push('## 2. 悬空引用（被引用但未定义）');
report.push('');
if (dangling.length === 0) {
  report.push('无。');
} else {
  report.push('| 编号 | 首次出现行 |');
  report.push('| --- | --- |');
  for (const id of dangling) report.push(`| ${id} | ${referenced.get(id)?.[0] ?? '-'} |`);
}
report.push('');
report.push('## 3. 已定义但未被引用');
report.push('');
if (unreferenced.length === 0) {
  report.push('无。');
} else {
  report.push('| 编号 | 定义行 |');
  report.push('| --- | --- |');
  for (const id of unreferenced) report.push(`| ${id} | ${defined.get(id).line} |`);
}
report.push('');
report.push('## 4. P0 条目覆盖');
report.push('');
report.push(`P0 条目共 ${p0.length} 条；P0 FR 共 ${p0Fr.length} 条；P0 AC 共 ${p0Ac.length} 条。`);
report.push('');
report.push('| 检查项 | 未覆盖数 | 未覆盖编号 |');
report.push('| --- | --- | --- |');
report.push(
  `| P0 FR 未进入 §8.6/§11 | ${p0FrMissing.length} | ${p0FrMissing.length ? p0FrMissing.join(', ') : '无'} |`
);
report.push(
  `| P0 AC 未进入 §11 | ${p0AcMissing.length} | ${p0AcMissing.length ? p0AcMissing.join(', ') : '无'} |`
);
report.push('');
report.push('## 5. 结论');
report.push('');
report.push(
  dangling.length === 0
    ? '**通过**：未发现悬空编号。'
    : `**未通过**：发现 ${dangling.length} 个悬空编号，需在正文补充定义或删除引用。`
);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${report.join('\n')}\n`, 'utf8');

console.log('M0 追溯矩阵检查');
console.log(`  定义编号: ${defined.size}`);
console.log(`  被引用编号: ${referenced.size}`);
console.log(`  悬空引用: ${dangling.length}`);
console.log(`  未引用编号: ${unreferenced.length}`);
console.log(`  报告: ${outFile}`);
if (dangling.length) {
  console.log('\n悬空编号:');
  for (const id of dangling) console.log(`  - ${id} (首次出现行 ${referenced.get(id)?.[0] ?? '-'})`);
  process.exitCode = 1;
}
