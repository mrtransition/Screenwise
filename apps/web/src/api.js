// 同源相对路径：前端由后端同端口托管时无需配置
const BASE = localStorage.getItem('proto.api') || '';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-proto-user': localStorage.getItem('proto.user') || 'local-user' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || json?.ok === false) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.code = json?.error?.code;
    err.status = res.status;
    err.detail = json?.error?.detail;
    throw err;
  }
  return json.data;
}

export const api = {
  health: () => req('GET', '/api/health'),
  listProjects: () => req('GET', '/api/projects'),
  createProject: (body) => req('POST', '/api/projects', body),
  getProject: (pid) => req('GET', `/api/projects/${pid}`),
  saveTokens: (pid, tokens) => req('PATCH', `/api/projects/${pid}/tokens`, { design_tokens: tokens }),
  getDesign: (pid) => req('GET', `/api/projects/${pid}/design`),
  updateDesign: (pid, body) => req('PATCH', `/api/projects/${pid}/design`, body),

  models: () => req('GET', '/api/models'),
  createModel: (body) => req('POST', '/api/models', body),
  updateModel: (id, body) => req('PATCH', `/api/models/${id}`, body),
  deleteModel: (id) => req('DELETE', `/api/models/${id}`),
  activateModel: (id) => req('POST', `/api/models/${id}/activate`, {}),
  testModel: (id) => req('POST', `/api/models/${id}/test`, {}),
  generator: () => req('GET', '/api/generator'),
  updateGenerator: (body) => req('PATCH', '/api/generator', body),

  listScreens: (pid) => req('GET', `/api/projects/${pid}/screens`),
  createScreen: (pid, body) => req('POST', `/api/projects/${pid}/screens`, body),
  getScreen: (pid, sid) => req('GET', `/api/projects/${pid}/screens/${sid}`),
  renameScreen: (pid, sid, body) => req('PATCH', `/api/projects/${pid}/screens/${sid}`, body),
  duplicateScreen: (pid, sid) => req('POST', `/api/projects/${pid}/screens/${sid}/duplicate`),
  deleteScreen: (pid, sid, body) => req('DELETE', `/api/projects/${pid}/screens/${sid}`, body),
  lock: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/lock`, body),
  unlock: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/unlock`, body),
  saveCanvasPos: (pid, sid, body) => req('PATCH', `/api/projects/${pid}/screens/${sid}/canvas`, body),
  reorder: (pid, ids) => req('POST', `/api/projects/${pid}/screens/reorder`, { ordered_ids: ids }),

  generate: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/generations`, body),
  applyPending: (pid, sid) => req('POST', `/api/projects/${pid}/screens/${sid}/pending/apply`, {}),
  rejectPending: (pid, sid) => req('POST', `/api/projects/${pid}/screens/${sid}/pending/reject`, {}),
  manualPatch: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/manual-patch`, body),
  jobs: (pid, sid) => req('GET', `/api/projects/${pid}/screens/${sid}/jobs`),

  versions: (pid, sid) => req('GET', `/api/projects/${pid}/screens/${sid}/versions`),
  version: (pid, sid, v) => req('GET', `/api/projects/${pid}/screens/${sid}/versions/${v}`),
  rollback: (pid, sid, version) => req('POST', `/api/projects/${pid}/screens/${sid}/rollback`, { version }),
  undo: (pid, sid) => req('POST', `/api/projects/${pid}/screens/${sid}/undo`, {}),
  diff: (pid, sid, a, b) => req('GET', `/api/projects/${pid}/screens/${sid}/diff?a=${a}&b=${b}`),

  flow: (pid) => req('GET', `/api/projects/${pid}/flow`),
  createEdge: (pid, body) => req('POST', `/api/projects/${pid}/flow/edges`, body),
  proposeEdge: (pid, body) => req('POST', `/api/projects/${pid}/flow/propose`, body),
  confirmEdge: (pid, body) => req('POST', `/api/projects/${pid}/flow/confirm`, body),
  updateEdge: (pid, id, body) => req('PATCH', `/api/projects/${pid}/flow/edges/${id}`, body),
  deleteEdge: (pid, id) => req('DELETE', `/api/projects/${pid}/flow/edges/${id}`),

  preview: (pid, start) => req('GET', `/api/projects/${pid}/preview${start ? `?start=${start}` : ''}`),
  exportProto: (pid, body) => req('POST', `/api/projects/${pid}/export`, body),
  prompt: (pid, { lang = 'zh', screenId = null } = {}) => {
    const q = new URLSearchParams({ lang });
    if (screenId) q.set('screen_id', screenId);
    return req('GET', `/api/projects/${pid}/prompt?${q.toString()}`);
  },
  promptPack: (pid, body) => req('POST', `/api/projects/${pid}/export`, { format: 'prompt', ...body }),
  audit: (pid) => req('GET', `/api/projects/${pid}/audit`),

  // M2 编辑器（API-018 / API-024）
  saveDoc: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/doc`, body),
  tidy: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/tidy`, body),
  convertScreen: (pid, sid, body) => req('POST', `/api/projects/${pid}/screens/${sid}/convert`, body || {}),
  schema: (name) => req('GET', `/api/schema/${name}`),
};

export function setApiBase(base) {
  localStorage.setItem('proto.api', base);
}
