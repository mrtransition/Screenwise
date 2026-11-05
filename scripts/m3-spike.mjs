#!/usr/bin/env node
/**
 * M0 数据模型 spike 演示：
 *   node scripts/m3-spike.mjs [m3e-doc.json]
 *
 * 默认使用 tests/fixtures/m3e-sample.json。流程：
 *   M3E Doc → ScreenDoc/FlowEdge → M3E Doc → 再导入
 * 并检查：屏数/边数守恒、ScreenDoc 无 action、导出无服务端字段、导出可重复。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importM3eProject, exportM3eProject } from '../apps/server/src/domain/m3/convert.js';
import { validateM3eDoc, validateScreenDoc } from '../apps/server/src/domain/m3/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] ?? path.join(here, '../tests/fixtures/m3e-sample.json');
const now = new Date().toISOString();

const fail = (message) => {
  console.error(`\n✖ ${message}`);
  process.exitCode = 1;
};

let raw;
try {
  raw = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (err) {
  fail(`读取输入失败: ${err.message}`);
  process.exit(1);
}

const issues = validateM3eDoc(raw);
if (issues.length) {
  fail(`输入不是合法 M3E Doc:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
  process.exit(1);
}

console.log(`M0 M3E 往返 spike`);
console.log(`输入: ${input}`);
console.log(`frames: ${raw.frames.length}, groups: ${raw.groups.length}`);

const first = importM3eProject(raw, { now, actor: 'spike' });
console.log(`\n1) 导入 → ScreenDoc / FlowEdge`);
console.log(`   屏: ${first.screens.length}（含未放置 ${first.screens.filter((s) => s.title === '未放置').length}）`);
console.log(`   边: ${first.edges.length}`);
console.log(`   告警: ${first.warnings.length}`);
for (const warning of first.warnings) console.log(`     - ${warning.code}: ${warning.message ?? warning.group_id ?? warning.from}`);

let screenIssueCount = 0;
for (const screen of first.screens) {
  const bad = validateScreenDoc(screen.doc);
  screenIssueCount += bad.length;
  if (JSON.stringify(screen.doc).includes('"action"')) fail(`ScreenDoc ${screen.screen_id} 仍包含 action`);
  if (JSON.stringify(screen.doc).includes('"swipe"')) fail(`ScreenDoc ${screen.screen_id} 仍包含 swipe`);
}
if (screenIssueCount) fail(`ScreenDoc 校验失败 ${screenIssueCount} 项`);

const exported = exportM3eProject({ design: first.design, screens: first.screens, edges: first.edges });
console.log(`\n2) 导出 → M3E Doc`);
console.log(`   frames: ${exported.doc.frames.length}, groups: ${exported.doc.groups.length}`);
console.log(`   边告警: ${exported.warnings.length}`);
if (exported.warnings.length) fail(`导出有 ${exported.warnings.length} 条边未写入`);

const exportIssues = validateM3eDoc(exported.doc);
if (exportIssues.length) fail(`导出不是合法 M3E Doc: ${exportIssues.map((i) => i.path).join(', ')}`);
for (const key of ['project_id', 'version', 'audit', 'pending', 'theme_snapshot']) {
  if (exported.doc[key] !== undefined) fail(`导出不应包含服务端字段 ${key}`);
}

const second = importM3eProject(exported.doc, { now });
console.log(`\n3) 再导入 → 守恒检查`);
console.log(`   屏: ${second.screens.length}（第一次 ${first.screens.length}）`);
console.log(`   边: ${second.edges.length}（第一次 ${first.edges.length}）`);
if (second.screens.length !== first.screens.length) fail('往返后屏数不一致');
if (second.edges.length !== first.edges.length) fail('往返后边数不一致');

const a = JSON.stringify(exportM3eProject({ design: second.design, screens: second.screens, edges: second.edges }).doc);
const b = JSON.stringify(exportM3eProject({ design: second.design, screens: second.screens, edges: second.edges }).doc);
if (a !== b) fail('同一输入两次导出结果不一致');

console.log(`\n4) 确定性: ${a === b ? '通过' : '失败'}`);
if (!process.exitCode) {
  console.log(`\n✔ M0 spike 通过：ScreenDoc / FlowEdge / M3E 往返一致。`);
} else {
  console.log(`\n✖ M0 spike 未通过，见上方错误。`);
}
