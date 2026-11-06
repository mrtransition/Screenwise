#!/usr/bin/env node
/**
 * 存储 v1 → v2 迁移命令（SRS §5.6.4）
 *
 *   npm run migrate:v2 -- --dry-run          只读扫描，输出报告
 *   npm run migrate:v2                       备份 → 原地迁移（失败自动回滚）
 *   npm run migrate:v2 -- --restore <dir>    从备份恢复
 *   npm run migrate:v2 -- --root <dataDir>   指定数据目录（默认 <repo>/data）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigration, planMigration, restoreData } from '../apps/server/src/store/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

const root = path.resolve(arg('--root', path.resolve(here, '..', 'data')));
const dryRun = args.includes('--dry-run');
const restore = arg('--restore');

function printPlan(plan) {
  console.log(`[migrate:v2] 数据目录 ${plan.root}`);
  console.log(`[migrate:v2] 项目 ${plan.summary.projects}：已迁移 ${plan.summary.migrated}，待迁移 ${plan.summary.pending}；屏幕 ${plan.summary.screens}`);
  for (const p of plan.projects) {
    if (!p.actions.length) continue;
    console.log(`  - ${p.pid} (${p.project.name})`);
    for (const a of p.actions) console.log(`      · ${a}`);
  }
  const legacy = plan.projects.flatMap((p) => p.screens.filter((s) => s.format === 'node-tree').map((s) => `${p.pid}/${s.screen_id}`));
  if (legacy.length) {
    console.log(`[migrate:v2] 只读 node-tree 屏 ${legacy.length} 个：${legacy.slice(0, 8).join(', ')}${legacy.length > 8 ? ' …' : ''}`);
    console.log('[migrate:v2] 这些屏保持原样，仅标记 format:"node-tree"；需要编辑请调用 POST /screens/:sid/convert');
  }
}

try {
  if (restore) {
    const out = await restoreData(root, restore);
    console.log(`[migrate:v2] 已从 ${out.restored_from} 恢复${out.previous ? `（原目录保留为 ${out.previous}）` : ''}`);
    process.exit(0);
  }
  if (dryRun) {
    printPlan(await planMigration(root));
    console.log('[migrate:v2] dry-run：未写入任何文件');
    process.exit(0);
  }
  const result = await runMigration(root, { dryRun: false });
  printPlan(result);
  if (result.skipped) console.log('[migrate:v2] 所有项目已是 v2，跳过写入');
  else console.log(`[migrate:v2] 完成；备份 ${result.backup}`);
} catch (err) {
  console.error(`[migrate:v2] 失败：${err.message}`);
  process.exit(1);
}
