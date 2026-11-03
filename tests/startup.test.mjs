import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 启动入口回归测试。
 *
 * 曾经的缺陷：入口判断写成
 *   import.meta.url === `file://${process.argv[1]}`
 * process.argv[1] 在 `node apps/server/src/index.js` 下是相对路径，
 * 与绝对 file:// URL 永不相等 → 启动代码整段被跳过 → 进程立刻 exit 0，
 * 端口根本没起来，表现为「run start 无效」。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'apps/server/src/index.js');

function startAndWait({ port, cwd = ROOT, args = ['apps/server/src/index.js'] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ child, ...result });
    };
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('[proto] 界面')) done({ exited: false, output: out });
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => done({ exited: true, code, output: out }));
    setTimeout(() => done({ exited: true, code: 'timeout', output: out }), 8000);
  });
}

test('从仓库根目录用相对路径启动，服务必须真正开始监听', async () => {
  const port = 18000 + Math.floor(Math.random() * 500);
  const r = await startAndWait({ port, cwd: ROOT });
  try {
    assert.equal(r.exited, false, `进程提前退出（code=${r.code}），启动分支未执行。输出：${r.output}`);
    assert.match(r.output, /\[proto\] 界面/);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'ok');
  } finally {
    r.child.kill();
  }
});

test('从入口所在目录启动同样可用（argv[1] 为 index.js）', async () => {
  const port = 18500 + Math.floor(Math.random() * 400);
  // 在 src/ 目录下用裸文件名启动，模拟用户 cd 进源码目录直接 run 的场景
  const r = await startAndWait({ port, cwd: path.join(ROOT, 'apps/server/src'), args: ['index.js'] });
  try {
    assert.equal(r.exited, false, `进程提前退出（code=${r.code}）`);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    r.child.kill();
  }
});

test('端口被占用时给出可操作的提示，而不是裸堆栈', async () => {
  const port = 19000 + Math.floor(Math.random() * 400);
  const first = await startAndWait({ port });
  assert.equal(first.exited, false);
  try {
    const second = await startAndWait({ port });
    assert.equal(second.exited, true, '第二个进程应退出');
    assert.equal(second.code, 1);
    assert.match(second.output, /端口 \d+ 已被占用/);
    assert.match(second.output, /PORT=/);
    assert.ok(!second.output.includes("Unhandled 'error' event"), '不应输出未处理的原始错误堆栈');
  } finally {
    first.child.kill();
  }
});
