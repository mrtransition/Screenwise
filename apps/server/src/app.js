import { createRouter, readBody, sendJson } from './http/router.js';
import { AppError } from './errors.js';
import path from 'node:path';

/**
 * REST 路由。<actor> 从请求头 x-proto-user 取，缺省 local-user。
 * 返回结构统一 { ok: true, data } / { ok:false, error:{code,message,detail} }。
 */
export function buildApp(service, { repoRoot }) {
  const r = createRouter();
  const actor = (req) => req.headers['x-proto-user'] || 'local-user';

  const wrap = (fn) => async (req, res, params, body) => {
    try {
      const data = await fn({ req, res, params, body });
      if (!res.writableEnded) sendJson(res, 200, { ok: true, data });
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message, detail: err.detail } });
        return;
      }
      if (err && err.code && ['INVALID_OUTPUT', 'UNPROCESSABLE', 'FORBIDDEN_TARGET', 'MODEL_FAILED'].includes(err.code)) {
        const status = err.code === 'MODEL_FAILED' ? 502 : err.code === 'FORBIDDEN_TARGET' ? 403 : 422;
        sendJson(res, status, {
          ok: false,
          error: { code: err.code, message: err.message, detail: err.detail || err.errors || null },
        });
        return;
      }
      console.error('[500]', err);
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
  };

  // ---- meta ----
  r.get('/api/health', wrap(async () => ({ status: 'ok', provider: await service.aiInfo(), storage: repoRoot })));

  // ---- AI model registry ----
  r.get('/api/models', wrap(async () => service.listModels()));
  r.post('/api/models', wrap(async ({ body }) => service.createModel(body)));
  r.patch('/api/models/:mid', wrap(async ({ params, body }) => service.updateModel(params.mid, body)));
  r.del('/api/models/:mid', wrap(async ({ params }) => service.deleteModel(params.mid)));
  r.post('/api/models/:mid/activate', wrap(async ({ params }) => service.activateModel(params.mid)));
  r.post('/api/models/:mid/test', wrap(async ({ params }) => service.testModel(params.mid)));

  // ---- 内置生成器维护（FR-ROUTE-009） ----
  r.get('/api/generator', wrap(async () => service.getGeneratorConfig()));
  r.patch('/api/generator', wrap(async ({ req, body }) => service.updateGeneratorConfig(body, { actor: actor(req) })));

  // ---- projects (FR-PROJ-001/002/003) ----
  r.get('/api/projects', wrap(async () => service.listProjects()));
  r.post('/api/projects', wrap(async ({ req, body }) => service.createProject({ ...body, actor: actor(req) })));
  r.get('/api/projects/:pid', wrap(async ({ params }) => service.getProject(params.pid)));
  r.patch('/api/projects/:pid/tokens', wrap(async ({ req, params, body }) => service.updateDesignTokens(params.pid, body.design_tokens, actor(req))));
  r.get('/api/projects/:pid/snapshot', wrap(async ({ params }) => service.repo.snapshot(params.pid)));

  // ---- screens (FR-PROJ-003 / FR-CANVAS-002) ----
  r.get('/api/projects/:pid/screens', wrap(async ({ params }) => service.listScreens(params.pid)));
  r.post('/api/projects/:pid/screens', wrap(async ({ req, params, body }) => service.createScreen(params.pid, { ...body, actor: actor(req) })));
  r.post('/api/projects/:pid/screens/:sid/duplicate', wrap(async ({ req, params }) => service.duplicateScreen(params.pid, params.sid, actor(req))));
  r.get('/api/projects/:pid/screens/:sid', wrap(async ({ params }) => service.getScreen(params.pid, params.sid)));
  r.patch('/api/projects/:pid/screens/:sid', wrap(async ({ req, params, body }) => service.renameScreen(params.pid, params.sid, body, actor(req))));
  r.patch('/api/projects/:pid/screens/:sid/canvas', wrap(async ({ req, params, body }) => service.patchCanvas(params.pid, { ...body, screen_id: params.sid, actor: actor(req) })));
  r.del('/api/projects/:pid/screens/:sid', wrap(async ({ req, params, body }) => service.deleteScreen(params.pid, params.sid, { ...body, actor: actor(req) })));
  r.post('/api/projects/:pid/screens/reorder', wrap(async ({ req, params, body }) => service.reorder(params.pid, body.ordered_ids, actor(req))));

  // ---- lock / versions (FR-CANVAS-005 / FR-VER-*) ----
  r.post('/api/projects/:pid/screens/:sid/lock', wrap(async ({ req, params, body }) => service.setLock(params.pid, params.sid, true, { actor: actor(req), reason: body?.reason })));
  r.post('/api/projects/:pid/screens/:sid/unlock', wrap(async ({ req, params, body }) => service.setLock(params.pid, params.sid, false, { actor: actor(req), reason: body?.reason })));
  r.get('/api/projects/:pid/screens/:sid/versions', wrap(async ({ params }) => service.listVersions(params.pid, params.sid)));
  r.get('/api/projects/:pid/screens/:sid/versions/:v', wrap(async ({ params }) => service.getVersion(params.pid, params.sid, params.v)));
  r.get('/api/projects/:pid/screens/:sid/diff', wrap(async ({ params, req }) => {
    const url = new URL(req.url, 'http://x');
    return service.diffVersions(params.pid, params.sid, url.searchParams.get('a'), url.searchParams.get('b'));
  }));
  r.post('/api/projects/:pid/screens/:sid/rollback', wrap(async ({ req, params, body }) => service.rollback(params.pid, params.sid, body.version, { actor: actor(req) })));
  r.post('/api/projects/:pid/screens/:sid/undo', wrap(async ({ req, params }) => service.undoLast(params.pid, params.sid, { actor: actor(req) })));

  // ---- generation (API-001/002/003) ----
  r.post('/api/projects/:pid/screens/:sid/generations', wrap(async ({ req, params, body }) =>
    service.startGeneration(params.pid, params.sid, { ...body, actor: actor(req) })
  ));
  r.post('/api/projects/:pid/screens/:sid/pending/apply', wrap(async ({ req, params }) => service.applyPending(params.pid, params.sid, { actor: actor(req) })));
  r.post('/api/projects/:pid/screens/:sid/pending/reject', wrap(async ({ req, params, body }) => service.rejectPending(params.pid, params.sid, { actor: actor(req), reason: body?.reason })));
  r.post('/api/projects/:pid/screens/:sid/manual-patch', wrap(async ({ req, params, body }) => service.manualPatch(params.pid, params.sid, { ...body, actor: actor(req) })));
  r.get('/api/projects/:pid/screens/:sid/jobs', wrap(async ({ params }) => {
    const h = await service.getHistory(params.pid);
    return h.jobs.filter((j) => j.target_screen_id === params.sid).reverse();
  }));
  r.get('/api/projects/:pid/screens/:sid/route-logs', wrap(async ({ params }) => service.listRouteLogs(params.pid, params.sid)));

  // ---- flow (API-005/006) ----
  r.get('/api/projects/:pid/flow', wrap(async ({ params }) => service.getFlow(params.pid)));
  r.post('/api/projects/:pid/flow/edges', wrap(async ({ req, params, body }) => service.createEdge(params.pid, body, { actor: actor(req) })));
  r.post('/api/projects/:pid/flow/propose', wrap(async ({ req, params, body }) => service.proposeEdge(params.pid, body, { actor: actor(req) })));
  r.post('/api/projects/:pid/flow/confirm', wrap(async ({ req, params, body }) => service.confirmCandidate(params.pid, body, { actor: actor(req) })));
  r.patch('/api/projects/:pid/flow/edges/:edgeId', wrap(async ({ req, params, body }) => service.updateEdge(params.pid, params.edgeId, body, { actor: actor(req) })));
  r.del('/api/projects/:pid/flow/edges/:edgeId', wrap(async ({ req, params }) => service.deleteEdge(params.pid, params.edgeId, { actor: actor(req) })));

  // ---- canvas ----
  r.get('/api/projects/:pid/canvas', wrap(async ({ params }) => service.repo.getCanvas(params.pid)));
  r.put('/api/projects/:pid/canvas', wrap(async ({ params, body }) => service.repo.saveCanvas(params.pid, body)));

  // ---- preview (API-007) ----
  r.get('/api/projects/:pid/preview', wrap(async ({ params, req }) => {
    const url = new URL(req.url, 'http://x');
    return service.buildPreview(params.pid, url.searchParams.get('start') || undefined);
  }));

  // ---- export (API-008) ----
  r.post('/api/projects/:pid/export', wrap(async ({ params, body }) => {
    const { exportStatic } = await import('./export/static.js');
    const payload = await service.buildPreview(params.pid, body?.start);
    const name = safeDirName(body?.name || `prototype-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const exportsRoot = path.resolve(repoRoot, '..', 'exports');
    const dir = path.resolve(exportsRoot, name);
    // 防止 body.name 里的 ../ 把导出物写到 exports 之外
    if (dir !== exportsRoot && !dir.startsWith(`${exportsRoot}${path.sep}`)) {
      throw new AppError({ code: 'BAD_REQUEST', status: 400 }, `非法的导出目录名: ${body?.name}`);
    }
    const out = await exportStatic(payload, dir);
    return { ...out, dir, screens: payload.screens.length, edges: payload.edges.length };
  }));

  // ---- audit ----
  r.get('/api/projects/:pid/audit', wrap(async ({ params, req }) => {
    const h = await service.getHistory(params.pid);
    const url = new URL(req.url, 'http://x');
    const sid = url.searchParams.get('screen_id');
    const audits = sid ? h.audits.filter((a) => a.object_id === sid || a.detail?.screen_id === sid) : h.audits;
    return { audits: audits.slice(-200), jobs: h.jobs.slice(-100) };
  }));

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hit = r.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
    if (!hit) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口 ${req.method} ${url.pathname}` } });
      return;
    }
    if (req.method !== 'GET') {
      // DELETE 也允许空 body
      let body = {};
      try {
        body = await readBody(req);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw e;
      }
      await hit.handler(req, res, hit.params, body);
      return;
    }
    await hit.handler(req, res, hit.params, {});
  }

  return { handle, router: r };
}

/** 导出目录名只保留安全字符，避免 Windows 非法字符与路径穿越 */
function safeDirName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    // 去掉首尾的点/横线：既避免 '..' 语义，也避免生成隐藏目录
    .replace(/^[.\-\s]+/g, '')
    .replace(/[.\-\s]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
  // Windows 保留设备名不能作为目录名
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!name || name === '.' || name === '..' || reserved.test(name)) return `prototype-${Date.now()}`;
  return name;
}
