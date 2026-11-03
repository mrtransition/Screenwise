import http from 'node:http';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Repo } from './store/repo.js';
import { Service } from './service.js';
import { buildApp } from './app.js';
import { ModelStore } from './ai/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../data');

export function createServer({ repoRoot = ROOT, service: injected, ai } = {}) {
  const repo = new Repo(repoRoot);
  const models = new ModelStore(repoRoot);
  const service = injected || new Service(repo, { ...(ai ? { ai } : {}), models });
  const app = buildApp(service, { repoRoot });
  const server = http.createServer(async (req, res) => {
    // 开发期 CORS（前端与后端不同端口）
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', 'content-type,x-proto-user');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,PUT,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // 前端静态资源（零构建：直接托管 apps/web）
    const urlPath = new URL(req.url, 'http://x').pathname;
    if (!urlPath.startsWith('/api')) {
      if (await serveStatic(req, res, urlPath)) return;
    }
    try {
      await app.handle(req, res);
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message, detail: err.detail } }));
      }
    }
  });
  return { server, repo, service, app };
}

// 用 pathToFileURL 归一化后再比较：process.argv[1] 可能是相对路径
// （node apps/server/src/index.js），而 import.meta.url 永远是绝对 file:// URL，
// 直接拼字符串比较在相对路径下必定不相等，进程会以 exit 0 静默结束。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  const { server } = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[proto] 端口 ${port} 已被占用。`);
      console.error(`        换个端口启动：  PORT=8788 npm start`);
      console.error(`        Windows PowerShell： $env:PORT=8788; npm start\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[proto] 界面 http://127.0.0.1:${port}/`);
    console.log(`[proto] API  http://127.0.0.1:${port}/api/health`);
    console.log(`[proto] data ${ROOT}`);
  });
}

const WEB_ROOT = path.resolve(__dirname, '../../web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 零构建前端托管：/ 与 /src/*.js 直接映射到 apps/web */
async function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // 浏览器会无条件请求 /favicon.ico，避免每次都刷一条 404
  if (urlPath === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><rect x="8" y="7" width="7" height="18" rx="1.5" fill="#fff"/><rect x="18" y="7" width="7" height="18" rx="1.5" fill="#fff" opacity=".55"/></svg>`;
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    res.end(svg);
    return true;
  }
  const clean = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const rel = clean === '' ? 'index.html' : clean;
  // 导出物托管在 <repo>/exports 下，便于导出后立即可预览
  const EXPORTS_ROOT = path.resolve(__dirname, '../../../exports');
  const isExport = rel.startsWith('exports/');
  const ROOT = isExport ? EXPORTS_ROOT : WEB_ROOT;
  const file = path.resolve(ROOT, isExport ? rel.slice('exports/'.length) : rel);
  if (!file.startsWith(ROOT)) return false;
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  } catch {
    // 只有"看起来像前端路由"的路径才回退到 index.html；
    // 带文件扩展名（如 /exports/x/index.html）找不到就是真 404，不能返回主应用
    if (/\.[a-z0-9]+$/i.test(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return true;
    }
    const index = path.join(WEB_ROOT, 'index.html');
    try {
      const buf = await fsp.readFile(index);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  }
}

