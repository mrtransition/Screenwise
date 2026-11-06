import { createRouter, readBody, readRawBody, parseMultipart, sendJson } from './http/router.js';
import { AppError } from './errors.js';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { KIND_SPECS } from './domain/m3/registry.js';

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
      if (err && err.code && ['INVALID_OUTPUT', 'UNPROCESSABLE', 'FORBIDDEN_TARGET', 'MODEL_FAILED', 'SCHEMA_INVALID', 'MIGRATION_UNSUPPORTED'].includes(err.code)) {
        const status =
          err.code === 'MODEL_FAILED'
            ? 502
            : err.code === 'FORBIDDEN_TARGET'
              ? 403
              : err.code === 'SCHEMA_INVALID' || err.code === 'MIGRATION_UNSUPPORTED'
                ? 422
                : 422;
        sendJson(res, status, {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            detail: err.issues ? { issues: err.issues } : err.detail || err.errors || null,
          },
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

  // ---- ProjectDesign（API-015/016：/design 是权威入口，/tokens 仅兼容投影） ----
  r.get('/api/projects/:pid/design', wrap(async ({ params }) => service.getDesign(params.pid)));
  r.patch('/api/projects/:pid/design', wrap(async ({ req, params, body }) => service.updateDesign(params.pid, body, actor(req))));

  // ---- Prompt 交付（API-020 / FR-PROMPT-*） ----
  r.get('/api/projects/:pid/prompt', wrap(async ({ params, req }) => {
    const url = new URL(req.url, 'http://x');
    return service.getPrompt(params.pid, {
      lang: url.searchParams.get('lang') || 'zh',
      screenId: url.searchParams.get('screen_id') || null,
    });
  }));

  // ---- 导入 / 导出（API-017/017b/026） ----
  r.post('/api/projects/import', wrap(async ({ req, res }) => {
    const payload = await readImportPayload(req);
    return service.importProject(payload.doc ?? payload.payload ?? payload, { name: payload.name, actor: actor(req) });
  }));
  r.post('/api/projects/:pid/import', wrap(async ({ req, params }) => {
    const payload = await readImportPayload(req);
    return service.importInto(params.pid, payload.doc ?? payload.payload ?? payload, { actor: actor(req) });
  }));
  r.post('/api/projects/:pid/validate', wrap(async ({ params }) => service.validateProject(params.pid)));
  r.get('/api/projects/:pid/export/:format', wrap(async ({ params, req, res }) => {
    const fmt = params.format;
    const url = new URL(req.url, 'http://x');
    if (fmt === 'm3e') {
      const out = await service.exportM3e(params.pid);
      return sendDownload(res, `${safeDirName(out.doc.title || 'm3e')}.m3e.json`, JSON.stringify(out.doc, null, 2));
    }
    if (fmt === 'backup' || fmt === 'bundle') {
      const out = await service.exportBackup(params.pid);
      return sendDownload(res, `${safeDirName(out.project?.name || 'project')}.m3studio.json`, JSON.stringify(out, null, 2));
    }
    if (fmt === 'prompt' || fmt === 'prompt.zip') {
      const out = await service.exportPromptPack(params.pid, {
        lang: url.searchParams.get('lang') || 'zh',
        screenId: url.searchParams.get('screen_id') || null,
      });
      const base = safeDirName(out.project_name || 'project');
      return sendBinaryDownload(res, `${base}-prompt.zip`, out.zip, 'application/zip');
    }
    throw new AppError({ code: 'BAD_REQUEST', status: 400 }, `不支持的导出格式: ${fmt}`);
  }));

  // ---- UI 状态 / 测量缓存 / 渲染契约（API-023/029/030） ----
  r.get('/api/projects/:pid/ui-state', wrap(async ({ params }) => service.getUiState(params.pid)));
  r.put('/api/projects/:pid/ui-state', wrap(async ({ req, params, body }) => service.saveUiState(params.pid, body, actor(req))));
  r.get('/api/projects/:pid/render-contract', wrap(async () => service.getRenderContract()));
  r.get('/api/schema/:name', wrap(async ({ params }) => schemaDescriptor(params.name)));

  // ---- screens (FR-PROJ-003 / FR-CANVAS-002) ----
  r.get('/api/projects/:pid/screens', wrap(async ({ params }) => service.listScreens(params.pid)));
  r.post('/api/projects/:pid/screens', wrap(async ({ req, params, body }) => service.createScreen(params.pid, { ...body, actor: actor(req) })));
  r.post('/api/projects/:pid/screens/:sid/duplicate', wrap(async ({ req, params }) => service.duplicateScreen(params.pid, params.sid, actor(req))));
  r.get('/api/projects/:pid/screens/:sid', wrap(async ({ params }) => service.getScreen(params.pid, params.sid)));
  r.patch('/api/projects/:pid/screens/:sid', wrap(async ({ req, params, body }) => service.renameScreen(params.pid, params.sid, body, actor(req))));
  r.patch('/api/projects/:pid/screens/:sid/canvas', wrap(async ({ req, params, body }) => service.patchCanvas(params.pid, { ...body, screen_id: params.sid, actor: actor(req) })));
  r.del('/api/projects/:pid/screens/:sid', wrap(async ({ req, params, body }) => service.deleteScreen(params.pid, params.sid, { ...body, actor: actor(req) })));
  r.post('/api/projects/:pid/screens/reorder', wrap(async ({ req, params, body }) => service.reorder(params.pid, body.ordered_ids, actor(req))));
  r.post('/api/projects/:pid/screens/:sid/convert', wrap(async ({ req, params, body }) => service.convertScreen(params.pid, params.sid, body, actor(req))));
  // API-018 编辑器保存整屏 ScreenDoc / API-024 Tidy 预览
  r.post('/api/projects/:pid/screens/:sid/doc', wrap(async ({ req, params, body }) => service.saveScreenDoc(params.pid, params.sid, body, { actor: actor(req) })));
  r.post('/api/projects/:pid/screens/:sid/tidy', wrap(async ({ req, params, body }) => service.tidyScreen(params.pid, params.sid, body, actor(req))));
  r.post('/api/projects/:pid/screens/:sid/measurements', wrap(async ({ req, params, body }) => service.saveMeasurements(params.pid, params.sid, body, actor(req))));

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
  r.put('/api/projects/:pid/canvas', wrap(async ({ req, params, body }) => service.saveCanvas(params.pid, body, actor(req))));

  // ---- preview (API-007) ----
  r.get('/api/projects/:pid/preview', wrap(async ({ params, req }) => {
    const url = new URL(req.url, 'http://x');
    return service.buildPreview(params.pid, url.searchParams.get('start') || undefined);
  }));

  // ---- export (API-008 / API-026) ----
  r.post('/api/projects/:pid/export', wrap(async ({ params, body }) => {
    const format = body?.format || 'static-dir';
    if (format === 'm3e') {
      const out = await service.exportM3e(params.pid, { includeHidden: body?.include_hidden === true });
      return { format, doc: out.doc, warnings: out.warnings, screens: out.screens };
    }
    if (format === 'backup' || format === 'bundle') {
      return { format, backup: await service.exportBackup(params.pid) };
    }
    if (format === 'prompt') {
      const out = await service.exportPromptPack(params.pid, { lang: body?.lang || 'zh', screenId: body?.screen_id || null });
      return {
        format,
        prompt: out.prompt,
        digest: out.digest,
        files: out.files,
        file_names: Object.keys(out.files),
        warnings: out.warnings,
        // 便于浏览器直接落盘；ZIP 本体也可通过 GET /export/prompt 下载
        zip_base64: out.zip.toString('base64'),
      };
    }
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
    return { ...out, format: 'static-dir', dir, screens: payload.screens.length, edges: payload.edges.length };
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
      // 导入接口自己读取原始请求体（支持 50MB multipart / 文件路径）
      if (req.method === 'POST' && /\/import\/?$/.test(url.pathname)) {
        await hit.handler(req, res, hit.params, undefined);
        return;
      }
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

const IMPORT_MAX = 50 * 1024 * 1024;

/** 读取导入数据：multipart 文件 / 原始 JSON / 服务端 file_path（NFR-037 / AC-611） */
async function readImportPayload(req) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    const raw = await readRawBody(req, IMPORT_MAX, 'IMPORT_TOO_LARGE');
    const { fields, files } = parseMultipart(raw, ct);
    const file = files.find((f) => /json$/i.test(f.filename || '')) || files[0];
    if (!file) throw new AppError({ code: 'BAD_REQUEST', status: 400 }, 'multipart 中没有文件字段');
    const payload = parseJsonBuffer(file.buffer, file.filename);
    if (fields.name) payload.name = fields.name;
    return payload;
  }
  const raw = await readRawBody(req, IMPORT_MAX, 'IMPORT_TOO_LARGE');
  if (!raw.length) throw new AppError({ code: 'BAD_REQUEST', status: 400 }, '导入请求体为空');
  const payload = parseJsonBuffer(raw, 'body');
  if (payload.file_path) {
    const abs = path.resolve(String(payload.file_path));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new AppError({ code: 'NOT_FOUND', status: 404 }, `文件不存在: ${payload.file_path}`);
    if (st.size > IMPORT_MAX) throw new AppError({ code: 'IMPORT_TOO_LARGE', status: 413 }, `文件超过 ${IMPORT_MAX / 1024 / 1024}MB 上限`);
    const buf = await fsp.readFile(abs);
    const filePayload = parseJsonBuffer(buf, abs);
    if (payload.name) filePayload.name = payload.name;
    return filePayload;
  }
  return payload;
}

function parseJsonBuffer(buf, label) {
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象');
    }
    return parsed;
  } catch (err) {
    throw new AppError({ code: 'BAD_JSON', status: 400 }, `${label} 不是合法 JSON: ${err.message}`);
  }
}

function sendDownload(res, filename, content) {
  return sendBinaryDownload(res, filename, Buffer.from(content, 'utf8'), 'application/json; charset=utf-8');
}

function sendBinaryDownload(res, filename, body, contentType) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const ascii = String(filename).replace(/[^\w.-]+/g, '_');
  res.writeHead(200, {
    'content-type': contentType || 'application/octet-stream',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
  return null;
}

/** 轻量 schema 描述（API-028）；完整 JSON Schema 在 M2 随编辑器发布 */
function schemaDescriptor(name) {
  // API-028：36 种 kind 的面板目录（客户端用它渲染部件面板，避免前端硬编码）
  if (name === 'kinds') {
    return {
      schema: 'm3studio/kinds@1',
      count: KIND_SPECS.length,
      kinds: KIND_SPECS.map((s) => ({
        kind: s.kind,
        label: s.label,
        family: s.family,
        hotspot: s.hotspot,
        text: s.text,
        slots: s.slots,
        w: s.w,
        h: s.h,
        variant: s.variant,
      })),
    };
  }
  if (name === 'screen') {
    return {
      schema: 'm3studio/screen@1',
      required: ['schema', 'format', 'frame', 'groups'],
      format: ['m3', 'node-tree'],
      frame: { id: 'string', name: 'string', x: 0, y: 0, w: 'number', h: 'number' },
      group: { id: 'string', x: 'number', y: 'number', axis: ['x', 'y', 'free'], items: 'Item[]' },
      item: { id: 'string', kind: 'string(36)', label: 'string', variant: ['filled', 'tonal', 'elevated', 'outlined', 'text'] },
      forbidden: ['item.action', 'item.actions', 'frame.swipe', 'item.pos(non-free)'],
    };
  }
  if (name === 'project') {
    return {
      schema: 'm3studio/project@1',
      design: ['title', 'brief', 'platform', 'paletteKey', 'customPalette', 'dynamicColor', 'theme', 'promptOptions', 'promptEdit'],
      theme: ['dark', 'bothModes', 'contrast', 'shape', 'font', 'emphasized', 'motion'],
    };
  }
  if (name === 'flow' || name === 'edge') {
    return {
      schema_version: 2,
      edge: ['edge_id', 'source_screen_id', 'source_item_id', 'source_slot', 'target_kind', 'target_screen_id', 'url', 'trigger', 'direction', 'transition', 'note', 'status', 'expires_at'],
      trigger: ['click', 'swipe', 'auto'],
      orphan: '动态计算，不持久化',
    };
  }
  throw new AppError({ code: 'NOT_FOUND', status: 404 }, `未知 schema: ${name}`);
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
