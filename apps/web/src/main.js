import { api } from './api.js';
import { CanvasView } from './canvas.js';
import { esc, toast, loading, modal, confirmDialog, errText, timeAgo } from './ui.js';
import { docToSrcdoc } from './render.js';

/**
 * 应用主控。
 * 三个工作态：edit / flow / preview。它们共享同一份数据，但**写入边界不同**：
 *  - edit：可写 screen（生成、patch、版本、锁定）
 *  - flow：只写 flow.json，对 screen 只读
 *  - preview：全只读
 */
const state = {
  projects: [],
  pid: null,
  project: null,
  screens: [],
  edges: [],
  selected: null,
  selectedDetail: null,
  mode: 'edit',
  busy: false,
  sideTab: 'generate',
  lastGen: null,
  /** 区域 / 组件级生成的选区：{ screen_id, node_ids, label } */
  selection: null,
  selectMode: false,
  genScope: 'screen',
  /** 最近一次拉取的模型目录，用于顶栏展示与弹层复用 */
  ai: null,
  /** 内置生成器维护配置（GET /api/generator），顶栏提示与维护弹层复用 */
  generator: null,
};

let canvas;

/* ---------------- 启动 ---------------- */

async function boot() {
  const app = document.getElementById('app');
  app.innerHTML = shell();
  bindShell();
  const canvasRoot = document.getElementById('canvasRoot');
  // 画布需要真实尺寸才能计算 fit；这里显式指定，避免 flex 计算时序问题
  canvasRoot.style.position = 'relative';
  canvas = new CanvasView(canvasRoot, {
    onSelect: (sid) => select(sid),
    onMove: (sid, pos) => {
      api.saveCanvasPos(state.pid, sid, pos).catch(() => {});
    },
    onConnect: (payload) => connectEdge(payload),
    onEdgeClick: (edgeId) => openEdgePanel(edgeId),
    onNodeSelect: (sid, nodeId) => selectNode(sid, nodeId),
    onNodeEdit: (sid, nodeId, text, original) => commitDirectEdit(sid, nodeId, text, original),
    onNodeFocus: (sid) => {
      if (sid && state.selected !== sid) select(sid);
    },
    onNodeEditCancel: (reason) => toast(reason === 'empty' ? '文案不能为空，已恢复原内容' : '已取消编辑', 'err'),
    onCreateScreen: () => createScreenDialog(),
    onExitFlow: () => setMode('edit'),
  });

  try {
    state.projects = await api.listProjects();
  } catch (e) {
    toast(`${errText(e)}（请确认后端已启动）`, 'err');
  }
  renderProjectPicker();
  window.addEventListener('resize', () => canvas.applyViewport());
  window.__state = state;   // 调试钩子
  window.__canvas = canvas;
  window.__ui = { select, refresh: refreshScreens, apply: applyScreens, load: loadProject, mode: setMode, preview: openPreview };
  if (state.projects.length) {
    await loadProject(state.projects[state.projects.length - 1].project_id);
  } else {
    showEmptyProject();
  }
}

function shell() {
  return `
  <div class="topbar">
    <div class="brand"><span class="dot"></span>逐屏原型</div>
    <select class="proj-select" id="projSelect"></select>
    <button class="btn sm" id="btnNewProj">新建项目</button>
    <div class="seg" id="modeSeg">
      <button data-mode="edit" class="on">画布</button>
      <button data-mode="flow">关联</button>
    </div>
    <span class="pill" id="providerPill" title="维护 / 选择 AI 模型">…</span>
    <div class="spacer"></div>
    <span class="pill warn" id="lockHint" style="display:none">当前屏已锁定</span>
    <button class="btn sm" id="btnTokens">设计规范</button>
    <button class="btn sm" id="btnPreview">▶ 预览</button>
    <button class="btn sm" id="btnExport">导出原型</button>
    <button class="btn sm" id="btnAudit">审计日志</button>
  </div>
  <div class="layout">
    <div class="main" id="canvasRoot"></div>
    <aside class="side" id="side">
      <div class="side-head">
        <h3 id="sideTitle">屏幕</h3>
        <span class="pill" id="sideScreenId" style="display:none"></span>
        <div class="spacer"></div>
        <button class="btn ghost sm" id="sideClose">收起</button>
      </div>
      <div class="side-body" id="sideBody"></div>
    </aside>
  </div>`;
}

function bindShell() {
  document.getElementById('projSelect').onchange = (e) => loadProject(e.target.value);
  document.getElementById('btnNewProj').onclick = newProjectDialog;
  document.getElementById('modeSeg').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  };
  document.getElementById('btnPreview').onclick = openPreview;
  document.getElementById('btnExport').onclick = doExport;
  document.getElementById('btnTokens').onclick = openTokensDialog;
  document.getElementById('btnAudit').onclick = openAudit;
  document.getElementById('providerPill').onclick = openModelDialog;
  document.getElementById('providerPill').style.cursor = 'pointer';
  document.getElementById('sideClose').onclick = () => document.getElementById('side').classList.toggle('collapsed');
  refreshAiPill();
}

function renderProjectPicker() {
  const sel = document.getElementById('projSelect');
  if (!state.projects.length) {
    sel.innerHTML = '<option>（无项目）</option>';
    return;
  }
  sel.innerHTML = state.projects.map((p) => `<option value="${p.project_id}">${esc(p.name)}</option>`).join('');
  if (state.pid) sel.value = state.pid;
}

function showEmptyProject() {
  document.getElementById('sideBody').innerHTML = `
    <div class="empty-state">
      <p style="font-size:15px;color:var(--ink)">还没有项目</p>
      <p class="hint">先建一个项目，再逐屏生成页面</p>
      <button class="btn primary" id="emptyNew">新建项目</button>
    </div>`;
  document.getElementById('emptyNew').onclick = newProjectDialog;
  canvas.setData({ screens: [], edges: [] });
}

/* ---------------- 项目 ---------------- */

async function loadProject(pid) {
  loading(true);
  try {
    state.pid = pid;
    state.project = await api.getProject(pid);
    // 切换项目时必须清空上一项目的选中态，否则侧栏会显示别的项目的屏
    state.selected = null;
    state.selectedDetail = null;
    state.selection = null;
    state.selectMode = false;
    state.genScope = 'screen';
    state.lastGen = null;
    canvas.setSelectMode(false);
    canvas.setSelection(null, []);
    await refreshScreens();
    document.getElementById('projSelect').value = pid;
    // 先渲染画布（不依赖选中流程），再加载选中屏详情
    applyScreens();
    if (state.screens.length) select(state.screens[0].screen_id);
    else {
      renderSide();
      renderCanvas();
    }
  } catch (e) {
    toast(errText(e), 'err');
  } finally {
    loading(false);
  }
}

async function refreshScreens() {
  const [screens, flow] = await Promise.all([api.listScreens(state.pid), api.flow(state.pid)]);
  state.screens = screens;
  state.edges = flow.edges;
}

function renderCanvas() {
  canvas.setData({ screens: state.screens, edges: state.edges });
  canvas.setSelected(state.selected);
}

function newProjectDialog() {
  const m = modal({
    title: '新建项目',
    body: `
      <div class="field"><label>项目名称</label><input class="input" id="npName" placeholder="例如：报销审批流程"></div>
      <div class="field"><label>设备尺寸</label>
        <div class="row">
          <input class="input" id="npW" value="375" type="number">
          <span class="hint">×</span>
          <input class="input" id="npH" value="812" type="number">
        </div>
        <span class="hint">默认 iPhone 尺寸；画布节点会按此尺寸渲染</span>
      </div>
      <div class="field"><label>设计规范（跨屏共享）</label>
        <div class="row">
          <input class="input color-input" id="npPrimary" type="color" value="#2563eb" title="主色">
          <select class="select" id="npRadius">
            <option value="6">小圆角 6px</option>
            <option value="10" selected>中圆角 10px</option>
            <option value="14">大圆角 14px</option>
          </select>
        </div>
        <span class="hint">主色与圆角会作为 design_tokens 注入每次生成，保证多屏风格一致</span>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-ok>创建</button>`,
  });
  m.footEl.querySelector('[data-ok]').onclick = async () => {
    const name = m.bodyEl.querySelector('#npName').value.trim();
    if (!name) return toast('请填写项目名称', 'err');
    const width = Number(m.bodyEl.querySelector('#npW').value) || 375;
    const height = Number(m.bodyEl.querySelector('#npH').value) || 812;
    const primary = m.bodyEl.querySelector('#npPrimary').value || '#2563eb';
    const radiusMd = Number(m.bodyEl.querySelector('#npRadius').value) || 10;
    try {
      const p = await api.createProject({
        name,
        device: { width, height },
        design_tokens: {
          colors: { primary },
          radius: { sm: Math.max(2, radiusMd - 4), md: radiusMd, lg: radiusMd + 4 },
        },
      });
      m.close();
      state.projects.push(p);
      renderProjectPicker();
      await loadProject(p.project_id);
      toast('项目已创建', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
}

/* ---------------- 设计规范（FR-PROJ-002） ---------------- */

function openTokensDialog() {
  if (!state.project) return toast('请先选择项目', 'err');
  const t = state.project.design_tokens || {};
  const c = t.colors || {};
  const radius = t.radius || {};
  const font = t.font || {};
  const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback);
  const m = modal({
    title: '设计规范',
    body: `
      <p class="hint" style="margin-top:0">设计 token 是唯一允许跨屏共享的上下文，后续每次生成都会注入这些值。</p>
      <div class="field"><label>主色</label>
        <div class="row">
          <input class="input color-input" id="tkPrimary" type="color" value="${esc(hex(c.primary, '#2563eb'))}">
          <span class="hint">按钮、强调文字与链接使用该颜色</span>
        </div>
      </div>
      <div class="row">
        <div class="field" style="flex:1"><label>正文色</label>
          <input class="input color-input" id="tkText" type="color" value="${esc(hex(c.text, '#111827'))}">
        </div>
        <div class="field" style="flex:1"><label>页面底色</label>
          <input class="input color-input" id="tkBg" type="color" value="${esc(hex(c.bg, '#f7f8fa'))}">
        </div>
      </div>
      <div class="row">
        <div class="field" style="flex:1"><label>基础圆角（px）</label>
          <input class="input" id="tkRadius" type="number" min="0" max="40" value="${Number(radius.md) || 10}">
        </div>
        <div class="field" style="flex:1"><label>基础字号（px）</label>
          <input class="input" id="tkFont" type="number" min="10" max="24" value="${Number(font.base) || 14}">
        </div>
      </div>
      <div class="field"><label>字体族</label>
        <input class="input" id="tkFamily" value="${esc(font.family || 'system-ui, -apple-system, "PingFang SC", sans-serif')}">
      </div>
      <p class="hint">修改只影响之后生成的屏幕；已有版本保持不变，可随时回滚。</p>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-ok>保存</button>`,
  });
  m.footEl.querySelector('[data-ok]').onclick = async () => {
    const md = Math.max(0, Number(m.bodyEl.querySelector('#tkRadius').value) || 10);
    const tokens = {
      colors: {
        primary: m.bodyEl.querySelector('#tkPrimary').value,
        text: m.bodyEl.querySelector('#tkText').value,
        bg: m.bodyEl.querySelector('#tkBg').value,
      },
      radius: { sm: Math.max(0, md - 4), md, lg: md + 4 },
      font: {
        base: Math.max(10, Number(m.bodyEl.querySelector('#tkFont').value) || 14),
        family: m.bodyEl.querySelector('#tkFamily').value.trim() || undefined,
      },
    };
    try {
      state.project = await api.saveTokens(state.pid, tokens);
      m.close();
      applyScreens();
      toast('设计规范已保存，将在后续生成中生效', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
}


/* ---------------- AI 模型维护 / 选择 ---------------- */

async function refreshAiPill() {
  const el = document.getElementById('providerPill');
  if (!el) return;
  try {
    state.ai = await api.models();
    state.generator = await api.generator().catch(() => null);
    paintAiPill();
  } catch {
    el.textContent = 'AI: 未连接';
    el.classList.add('warn');
  }
}

function paintAiPill() {
  const el = document.getElementById('providerPill');
  if (!el) return;
  const data = state.ai;
  const active = data?.models?.find((m) => m.model_id === data.active_model_id);
  if (!active) {
    el.textContent = 'AI: 未配置';
    el.classList.add('warn');
    return;
  }
  el.classList.remove('warn');
  el.textContent = `AI: ${active.name}`;
  const gen = state.generator;
  const genState =
    !gen || gen.scope === 'off'
      ? '内置生成器已关闭'
      : `内置生成器 ${gen.scope === 'explicit_only' ? '仅处理结构化指令' : '已开启'}（${gen.rules.length} 条规则）`;
  el.title =
    active.provider === 'local'
      ? `当前使用内置确定性生成器 · ${genState} · 点击维护 / 选择模型`
      : `当前模型 ${active.model} · ${active.base_url} · ${genState} · 点击维护 / 选择模型`;
}

async function openModelDialog() {
  let data;
  try {
    data = await api.models();
  } catch (e) {
    return toast(errText(e), 'err');
  }
  state.ai = data;

  const m = modal({
    title: 'AI 模型',
    width: 'min(820px,94vw)',
    body: '<div id="modelBody"></div>',
    footer: `<button class="btn" data-close>关闭</button><button class="btn" id="generatorEntry">内置生成器设置</button><button class="btn primary" id="modelAdd">＋ 新增模型</button>`,
  });
  const bodyEl = m.bodyEl.querySelector('#modelBody');

  async function renderList() {
    try {
      state.ai = await api.models();
      // 内置生成器配置与模型列表同源刷新，避免两处状态不一致
      state.generator = await api.generator().catch(() => state.generator);
    } catch (e) {
      bodyEl.innerHTML = `<p class="warn-text">${esc(errText(e))}</p>`;
      return;
    }
    paintAiPill();
    bodyEl.innerHTML = modelListHtml(state.ai, state.generator);
    bodyEl.querySelectorAll('[data-generator]').forEach((btn) => {
      btn.onclick = () => openGeneratorDialog({ onSaved: renderList });
    });
    bodyEl.querySelectorAll('[data-activate]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api.activateModel(btn.dataset.activate);
          toast('已切换当前模型，后续生成将使用它', 'ok');
          await renderList();
        } catch (e) {
          btn.disabled = false;
          toast(errText(e), 'err');
        }
      };
    });
    bodyEl.querySelectorAll('[data-test-model]').forEach((btn) => {
      btn.onclick = async () => {
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = '测试中…';
        try {
          const r = await api.testModel(btn.dataset.testModel);
          if (r.ok) {
            toast(`连接正常 · ${r.latency_ms}ms · ${r.model || ''}`, 'ok');
            btn.textContent = `✓ ${r.latency_ms}ms`;
          } else {
            const hint = r.detail?.hint ? `\n${r.detail.hint}` : '';
            toast(`${r.message || '连接失败'}${hint}`, 'err');
            btn.textContent = '✗ 连接失败';
          }
        } catch (e) {
          toast(errText(e), 'err');
          btn.textContent = label;
        } finally {
          btn.disabled = false;
          setTimeout(() => {
            if (btn.isConnected) btn.textContent = label;
          }, 4000);
        }
      };
    });
    bodyEl.querySelectorAll('[data-edit-model]').forEach((btn) => {
      btn.onclick = () => {
        const model = state.ai.models.find((x) => x.model_id === btn.dataset.editModel);
        if (model) renderForm(model);
      };
    });
    bodyEl.querySelectorAll('[data-del-model]').forEach((btn) => {
      btn.onclick = async () => {
        const model = state.ai.models.find((x) => x.model_id === btn.dataset.delModel);
        if (!model) return;
        const ok = await confirmDialog({
          title: '删除模型',
          message: `删除「${esc(model.name)}」？<br><br>如果它是当前模型，会自动回退到内置生成器；已有版本与屏幕内容不受影响。`,
          danger: true,
          okText: '删除',
        });
        if (!ok) return;
        try {
          await api.deleteModel(model.model_id);
          toast('模型已删除', 'ok');
          await renderList();
        } catch (e) {
          toast(errText(e), 'err');
        }
      };
    });
    const add = m.footEl.querySelector('#modelAdd');
    if (add) add.onclick = () => renderForm(null);
  }

  function renderForm(model) {
    const isEdit = !!model;
    const builtin = !!model?.builtin;
    bodyEl.innerHTML = modelFormHtml(model);
    const save = bodyEl.querySelector('#modelSave');
    const cancel = bodyEl.querySelector('#modelCancel');
    if (cancel) cancel.onclick = () => renderList();
    if (!save) return;
    save.onclick = async () => {
      const name = bodyEl.querySelector('#mfName').value.trim();
      if (!name) return toast('请填写模型名称', 'err');
      save.disabled = true;
      try {
        if (builtin) {
          await api.updateModel(model.model_id, { name });
        } else {
          const keyEl = bodyEl.querySelector('#mfKey');
          const key = keyEl ? keyEl.value.trim() : '';
          const clear = bodyEl.querySelector('#mfClearKey')?.checked;
          const body = {
            name,
            provider: 'openai-compatible',
            model: bodyEl.querySelector('#mfModel').value.trim(),
            base_url: bodyEl.querySelector('#mfBase').value.trim(),
            timeout_ms: Number(bodyEl.querySelector('#mfTimeout').value) || 30000,
            enabled: !!bodyEl.querySelector('#mfEnabled')?.checked,
          };
          if (key) body.api_key = key;
          else if (isEdit && clear) body.clear_api_key = true;
          if (isEdit) await api.updateModel(model.model_id, body);
          else await api.createModel(body);
        }
        toast(isEdit ? '模型已更新' : '模型已新增', 'ok');
        await renderList();
      } catch (e) {
        save.disabled = false;
        toast(errText(e), 'err');
      }
    };
  }

  await renderList();
}

function modelListHtml(data, generator = null) {
  const models = data?.models || [];
  const active = models.find((m) => m.model_id === data.active_model_id);
  const genLabel =
    !generator || generator.scope === 'off'
      ? '已关闭'
      : generator.scope === 'explicit_only'
        ? '仅结构化指令'
        : '全部规则';
  return `
    <p class="hint" style="margin-top:0">
      当前使用：<strong>${esc(active?.name || '未配置')}</strong>。模型配置保存在服务端，API Key 不会回显明文。
    </p>
    <div class="model-list">
      ${
        models
          .map(
            (m) => `
        <div class="model-card ${m.active ? 'active' : ''}">
          <div class="model-head">
            <strong>${esc(m.name)}</strong>
            ${m.active ? '<span class="badge v">当前使用</span>' : ''}
            ${m.builtin ? '<span class="badge">内置</span>' : ''}
            ${m.enabled ? '' : '<span class="badge lock">已停用</span>'}
          </div>
          <div class="model-meta">
            <span>${m.provider === 'local' ? '本地生成' : 'OpenAI 兼容'}</span>
            <code class="mono">${esc(m.model || '-')}</code>
            ${m.provider === 'local' ? '' : `<span class="model-url">${esc(m.base_url || '未配置 Base URL')}</span>`}
            ${m.provider === 'local' ? '' : `<span>${m.has_api_key ? `密钥 ${esc(m.api_key_hint)}` : '未配置密钥'}</span>`}
            ${m.provider === 'local' && generator ? `<span>确定性路由 ${esc(genLabel)}</span><span>${generator.rules.length} 条规则</span>` : ''}
            <span>超时 ${Number(m.timeout_ms) || 30000}ms</span>
          </div>
          <div class="model-actions">
            ${
              m.active
                ? ''
                : `<button class="btn sm primary" data-activate="${esc(m.model_id)}" ${m.enabled ? '' : 'disabled'}>使用此模型</button>`
            }
            <button class="btn sm" data-edit-model="${esc(m.model_id)}">编辑</button>
            ${m.builtin ? '<button class="btn sm primary" data-generator>内置生成器设置</button>' : ''}
            ${m.builtin ? '' : `<button class="btn sm" data-test-model="${esc(m.model_id)}">测试连接</button>`}
            ${m.builtin ? '' : `<button class="btn sm danger" data-del-model="${esc(m.model_id)}">删除</button>`}
          </div>
        </div>`
          )
          .join('') || '<div class="empty-state" style="padding:30px 10px">还没有可用模型</div>'
      }
    </div>
    <p class="hint">切换模型只影响之后的生成任务；已经生成的版本不会被改写。</p>`;
}

function modelFormHtml(model) {
  const isEdit = !!model;
  const builtin = !!model?.builtin;
  const name = model?.name || '';
  const modelName = model?.model || '';
  const baseUrl = model?.base_url || '';
  const timeout = Number(model?.timeout_ms) || 30000;
  const enabled = model ? !!model.enabled : true;
  return `
    <div class="row" style="margin-bottom:14px">
      <strong style="font-size:13px">${isEdit ? '编辑模型' : '新增模型'}</strong>
      <span class="hint" style="margin-left:auto">${builtin ? '内置模型' : 'OpenAI 兼容接口'}</span>
    </div>
    <div class="field"><label>模型名称 <span style="color:var(--danger)">*</span></label>
      <input class="input" id="mfName" value="${esc(name)}" placeholder="例如：GPT-4o / 公司内部模型">
      <span class="hint">显示在顶栏与模型列表中的名称，可用中文</span>
    </div>
    ${
      builtin
        ? `<div class="card" style="margin-bottom:12px">
            <div class="kv"><span>provider</span><span><code class="mono">local</code></span></div>
            <div class="kv"><span>model</span><span><code class="mono">local-deterministic</code></span></div>
            <p class="hint" style="margin:8px 0 0">内置生成器不依赖网络，也不能被删除或停用；它的名称可以修改。</p>
          </div>`
        : `
    <div class="field"><label>接入类型</label>
      <select class="select" id="mfProvider"><option value="openai-compatible" selected>OpenAI 兼容（/chat/completions）</option></select>
    </div>
    <div class="field"><label>模型标识 <span style="color:var(--danger)">*</span></label>
      <input class="input" id="mfModel" value="${esc(modelName)}" placeholder="例如：gpt-4o">
      <span class="hint">请求体里的 model 字段</span>
    </div>
    <div class="field"><label>Base URL <span style="color:var(--danger)">*</span></label>
      <input class="input" id="mfBase" value="${esc(baseUrl)}" placeholder="例如：https://api.openai.com/v1">
      <span class="hint">系统会请求 Base URL + /chat/completions。只填域名会自动补 /v1；直接粘贴完整的 .../chat/completions 也可以。</span>
    </div>
    <div class="field"><label>API Key</label>
      <input class="input" id="mfKey" type="password" autocomplete="new-password"
        placeholder="${isEdit && model.has_api_key ? '留空表示保持现有密钥' : '可留空（自建服务通常不需要）'}">
      <span class="hint">密钥只保存在服务端，列表接口只返回是否已配置与末四位。</span>
      ${
        isEdit && model.has_api_key
          ? `<label class="check"><input type="checkbox" id="mfClearKey"> 清除已保存的密钥</label>`
          : ''
      }
    </div>
    <div class="row">
      <div class="field" style="flex:1"><label>超时（毫秒）</label>
        <input class="input" id="mfTimeout" type="number" min="1000" max="120000" value="${timeout}">
      </div>
      <label class="check" style="margin-top:20px"><input type="checkbox" id="mfEnabled" ${enabled ? 'checked' : ''}> 启用此模型</label>
    </div>`
    }
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="modelSave">保存</button>
      <button class="btn" id="modelCancel">取消</button>
    </div>`;
}


/* ---------------- 内置生成器维护（FR-ROUTE-009） ---------------- */

/**
 * 内置生成器维护弹层：名称、启用范围、启用规则、确定性路由开关。
 * 与「AI 模型」弹层同源：保存后回写 state.generator 并刷新顶栏提示。
 * 关闭内置生成器（scope=off）后，确定性请求会按 FR-ROUTE-009 回落到大模型。
 */
async function openGeneratorDialog({ onSaved } = {}) {
  let cfg;
  try {
    cfg = await api.generator();
  } catch (e) {
    return toast(errText(e), 'err');
  }

  const scopeOptions = [
    ['global', '全局：规则与结构化指令都走内置生成器'],
    ['explicit_only', '仅显式：只处理带 node_id / anchor 的结构化指令'],
    ['off', '关闭：确定性请求也走大模型'],
  ];

  const m = modal({
    title: '内置生成器设置',
    width: 'min(720px,94vw)',
    body: `
      <p class="hint" style="margin-top:0">
        内置生成器是确定性、无网络、恒可用的生成路径。它只处理「可唯一确定变更值」的文字类修改，
        含创作意图（优化 / 更有 / 风格）或否定约束（不要改 / 除了）的请求会升级到大模型。
      </p>
      <div class="field"><label>名称</label>
        <input class="input" id="genName" value="${esc(cfg.name)}" placeholder="内置生成器">
        <span class="hint">显示在顶栏与模型列表中的名称，可用中文</span>
      </div>
      <div class="field"><label>启用范围</label>
        <select class="select" id="genScope">
          ${scopeOptions.map(([v, label]) => `<option value="${v}" ${cfg.scope === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <span class="hint">${esc(cfg.scope_hint?.[cfg.scope] || '')}</span>
      </div>
      <div class="field"><label>启用的规则</label>
        <div class="rule-grid">
          ${cfg.available_rules
            .map(
              (id) => `
            <label class="check"><input type="checkbox" data-rule="${esc(id)}" ${cfg.rules.includes(id) ? 'checked' : ''}>
              <span>${esc(cfg.rule_labels?.[id] || id)}<code class="mono">${esc(id)}</code></span>
            </label>`
            )
            .join('')}
        </div>
        <span class="hint">取消勾选后，该类请求不再短路，改走大模型；规则本身的边界不被放宽。</span>
      </div>
      <div class="field"><label>确定性路由</label>
        <label class="check"><input type="checkbox" id="genRouter" ${cfg.router_enabled ? 'checked' : ''}>启用路由判定（关闭后所有请求都走大模型）</label>
      </div>
      <div class="card" style="margin-top:6px">
        <div class="kv"><span>provider</span><span><code class="mono">local</code></span></div>
        <div class="kv"><span>model</span><span><code class="mono">local-deterministic</code></span></div>
        <div class="kv"><span>最近更新</span><span>${cfg.updated_at ? `${esc(timeAgo(cfg.updated_at))} · ${esc(cfg.updated_by || 'system')}` : '默认配置'}</span></div>
        <p class="hint" style="margin:8px 0 0">内置生成器不依赖网络，不能被删除或停用；关闭「启用范围」等价于关闭它。</p>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="genSave">保存</button>`,
  });

  const scopeEl = m.bodyEl.querySelector('#genScope');
  const hintEl = scopeEl.nextElementSibling;
  scopeEl.onchange = () => {
    hintEl.textContent = cfg.scope_hint?.[scopeEl.value] || '';
  };

  m.footEl.querySelector('#genSave').onclick = async (ev) => {
    const btn = ev.currentTarget;
    const name = m.bodyEl.querySelector('#genName').value.trim();
    if (!name) return toast('请填写内置生成器名称', 'err');
    const rules = Array.from(m.bodyEl.querySelectorAll('[data-rule]:checked')).map((el) => el.dataset.rule);
    const scope = scopeEl.value;
    if (scope !== 'off' && !rules.length) return toast('至少启用一条规则，或把启用范围设为「关闭」', 'err');
    btn.disabled = true;
    try {
      state.generator = await api.updateGenerator({
        name,
        scope,
        rules,
        router_enabled: !!m.bodyEl.querySelector('#genRouter').checked,
      });
      paintAiPill();
      toast(scope === 'off' ? '内置生成器已关闭，确定性请求将走大模型' : '内置生成器设置已保存，仅影响之后的生成', 'ok');
      m.close();
      if (onSaved) await onSaved();
    } catch (e) {
      btn.disabled = false;
      toast(errText(e), 'err');
    }
  };
}

/* ---------------- 屏幕 ---------------- */

async function select(sid) {
  if (state.selection && state.selection.screen_id !== sid) clearSelection({ silent: true });
  state.selected = sid;
  canvas.setSelected(sid);
  if (!sid) {
    state.selectedDetail = null;
    renderSide();
    return;
  }
  try {
    state.selectedDetail = await api.getScreen(state.pid, sid);
  } catch (e) {
    toast(errText(e), 'err');
  }
  renderSide();
  const s = state.screens.find((x) => x.screen_id === sid);
  document.getElementById('lockHint').style.display = s?.locked ? 'inline-block' : 'none';
}

/**
 * 热区坐标全部由画布 iframe 内实测后回传（见 render.js 的 measure 脚本 + canvas.observeAnchors）。
 * 这里绝不能再用"按序号估算"覆盖真实坐标：那样每次刷新屏幕列表都会把热区推回左上角，
 * 表现为关联模式下热区不落在组件上。
 */
function decorateAnchors() {
  for (const s of state.screens) {
    s.anchors = s.anchors || [];
  }
}

function applyScreens() {
  decorateAnchors();
  renderCanvas();
  renderSide();
}

async function createScreenDialog() {
  const m = modal({
    title: '新建屏幕',
    body: `
      <div class="field"><label>屏幕名称</label><input class="input" id="csTitle" placeholder="例如：审批列表"></div>
      <div class="field"><label>备注（可选）</label><input class="input" id="csRemark" placeholder="这一屏要解决什么问题"></div>
      <p class="hint">新屏只生成空屏基线，不消耗 AI 生成。之后可在右侧面板逐屏生成。</p>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-ok>创建</button>`,
  });
  m.footEl.querySelector('[data-ok]').onclick = async () => {
    const title = m.bodyEl.querySelector('#csTitle').value.trim();
    if (!title) return toast('请填写屏幕名称', 'err');
    try {
      const s = await api.createScreen(state.pid, { title, remark: m.bodyEl.querySelector('#csRemark').value.trim() });
      m.close();
      await refreshScreens();
      applyScreens();
      select(s.screen_id);
      toast('屏幕已创建', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
}

/** 调整屏幕顺序（FR-PROJ-003）：只改元数据 order，不动内容 */
async function moveScreen(sid, dir) {
  const ids = state.screens.map((s) => s.screen_id);
  const from = ids.indexOf(sid);
  const to = dir === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  try {
    state.screens = await api.reorder(state.pid, ids);
    applyScreens();
    toast('已调整屏幕顺序', 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}


/* ---------------- 侧栏 ---------------- */

function renderSide() {
  const body = document.getElementById('sideBody');
  const titleEl = document.getElementById('sideTitle');
  const sidEl = document.getElementById('sideScreenId');
  const d = state.selectedDetail;

  if (!d) {
    titleEl.textContent = `屏幕清单（${state.screens.length}）`;
    sidEl.style.display = 'none';
    body.innerHTML = `
      <p class="hint">选中画布上的任意屏幕开始工作。也可先维护屏幕清单，再逐屏生成。</p>
      <div class="edge-list" style="margin-top:12px">
        ${state.screens
          .map(
            (s, i) => `
          <div class="ver-item" data-goto="${esc(s.screen_id)}">
            <span class="ver-num">${i + 1}</span>
            <span style="flex:1">${esc(s.title)}</span>
            <span class="ver-meta">${s.locked ? '🔒' : ''} v${s.current_version}</span>
            <span class="ver-actions">
              <button class="btn sm ghost" data-move="up" data-sid="${esc(s.screen_id)}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
              <button class="btn sm ghost" data-move="down" data-sid="${esc(s.screen_id)}" ${i === state.screens.length - 1 ? 'disabled' : ''} title="下移">↓</button>
            </span>
          </div>`
          )
          .join('') || '<div class="hint">还没有屏幕</div>'}
      </div>
      <button class="btn primary" style="width:100%;margin-top:14px" id="sideAddScreen">＋ 新建屏幕</button>`;
    body.querySelectorAll('[data-goto]').forEach((el) => (el.onclick = () => select(el.dataset.goto)));
    body.querySelectorAll('[data-move]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        moveScreen(el.dataset.sid, el.dataset.move);
      };
    });
    body.querySelector('#sideAddScreen').onclick = createScreenDialog;
    return;
  }

  titleEl.textContent = d.title;
  sidEl.style.display = 'inline-block';
  sidEl.textContent = d.screen_id;
  sidEl.title = d.screen_id;

  body.innerHTML = `
    <div class="row" style="gap:6px;margin-bottom:12px">
      ${tabs()}
    </div>
    <div id="tabBody"></div>`;

  body.querySelectorAll('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        state.sideTab = b.dataset.tab;
        renderSide();
      })
  );
  renderTab();
}

function tabs() {
  const t = [
    ['generate', '生成'],
    ['versions', '版本'],
    ['meta', '属性'],
  ];
  if (state.mode === 'flow') t.push(['edges', '关联边']);
  return t
    .map(
      ([k, label]) =>
        `<button class="btn sm ${state.sideTab === k ? 'primary' : ''}" data-tab="${k}">${label}</button>`
    )
    .join('');
}

function renderTab() {
  const el = document.getElementById('tabBody');
  if (!el) return;
  const d = state.selectedDetail;
  if (state.sideTab === 'generate') el.innerHTML = generatePanel(d);
  else if (state.sideTab === 'versions') renderVersions(d, el);
  else if (state.sideTab === 'meta') el.innerHTML = metaPanel(d);
  else if (state.sideTab === 'edges') el.innerHTML = edgesPanel();

  bindTab(d);
}

function generatePanel(d) {
  const locked = d.locked;
  const hasPending = !!d.pending;
  const sel = state.selection && state.selection.screen_id === d.screen_id ? state.selection : null;
  const scope = state.genScope || 'screen';
  return `
    ${hasPending ? pendingCard(d) : ''}
    <div class="field">
      <label>生成范围 <span style="color:var(--danger)">*</span></label>
      <select class="select" id="genScope" ${locked ? 'disabled' : ''}>
        <option value="screen" ${scope === 'screen' ? 'selected' : ''}>整屏（编辑时优先输出局部 patch）</option>
        <option value="region" ${scope === 'region' ? 'selected' : ''}>区域（只改选中的区块）</option>
        <option value="component" ${scope === 'component' ? 'selected' : ''}>组件（只改选中的组件）</option>
      </select>
      <span class="hint">${
        scope === 'screen'
          ? '修改类指令会优先产出局部 patch，不会整屏覆盖。'
          : scope === 'component'
            ? '组件级只支持单个节点：先在屏幕上点选一个组件，需求描述只作用在它上面。'
            : '区域级：先在屏幕上点选一块区块，需求描述只作用在选区内，不会改动其他部分。'
      }</span>
    </div>
    <div class="field">
      <label>当前选区</label>
      ${
        sel
          ? `<div class="sel-card">
              <div class="sel-main"><span class="sel-dot"></span><strong>${esc(sel.label || sel.node_ids[0])}</strong></div>
              <div class="hint">node_id: <code class="mono">${esc(sel.node_ids[0])}</code></div>
            </div>`
          : `<div class="sel-empty">还没有选区。切换到「区域 / 组件」后，点下方按钮，再在屏幕节点里点击要修改的区块。</div>`
      }
      <div class="row" style="margin-top:6px">
        <button class="btn sm" id="btnPickNode" ${locked || state.mode !== 'edit' ? 'disabled' : ''}>
          ${state.selectMode ? '正在选择…（点屏幕内区块）' : '在屏幕上选择'}
        </button>
        ${sel ? '<button class="btn sm ghost" id="btnClearSel">清除选区</button>' : ''}
      </div>
    </div>
    <div class="field">
      <label>需求描述</label>
      <textarea class="textarea" id="genPrompt" ${locked ? 'disabled' : ''}
        placeholder="例如：登录页，手机号 + 验证码登录，顶部是欢迎语，底部放注册入口"></textarea>
      <span class="hint">修改类指令（如「把按钮文案改成立即进入」）会优先产出局部 patch</span>
    </div>
    ${locked ? '<p class="warn-text">🔒 该屏幕已锁定，生成与修改已禁用（服务端同样会拒绝）。</p>' : ''}
    <p class="hint" style="margin-top:2px">提示：直接双击画布中的文字可修改文案，失焦或回车即保存为「人工」版本；Esc 取消。</p>
    <div class="gen-actions">
      <button class="btn primary" id="btnGen" ${locked ? 'disabled' : ''}>生成</button>
      <button class="btn" id="btnGenFull" ${locked ? 'disabled' : ''} title="整屏重生成会覆盖现有内容（会先生成待确认版本）">整屏重生成</button>
    </div>
    ${state.lastGen ? lastGenCard(state.lastGen) : ''}`;
}

function pendingCard(d) {
  const p = d.pending;
  const route = p.route_layer
    ? `<span class="badge ${p.change_source === 'builtin_rule' ? 'v' : ''}" title="route_layer=${esc(p.route_layer)}">${p.change_source === 'builtin_rule' ? '内置生成器 · 未调用大模型' : `大模型 · ${esc(p.route_layer)}`}</span>`
    : '';
  return `
    <div class="card" style="border-color:#bfdbfe;background:#f8fbff;margin-bottom:14px">
      <div class="row" style="margin-bottom:8px">
        <strong style="font-size:13px">待确认的${p.mode === 'full' ? '整屏生成' : '局部 patch'}</strong>
        <span class="badge pending">${p.mode}</span>
        ${route}
      </div>
      ${p.change_summary ? `<div class="hint" style="margin-bottom:6px">${esc(p.change_summary)}</div>` : ''}
      <div class="hint" style="margin-bottom:8px">${esc(p.prompt || '')}</div>
      ${diffHtml(p.diff)}
      <div class="gen-actions">
        <button class="btn primary" id="btnApply" ${d.locked ? 'disabled' : ''}>接受并生成新版本</button>
        <button class="btn" id="btnReject">拒绝</button>
      </div>
      <p class="hint" style="margin-bottom:0">接受前不会写入正式版本（当前 v${d.current_version}）。</p>
    </div>`;
}

function diffHtml(diff = []) {
  if (!diff?.length) return '';
  return `<div class="diff-list">${diff
    .map(
      (x) => `<div class="diff-item ${x.op === 'full-regenerate' ? 'full' : ''}">
        <code class="mono">${esc(x.op)}</code> <small>${esc(x.node_id || '')}</small>
      </div>`
    )
    .join('')}</div>`;
}

function lastGenCard(g) {
  return `
    <div class="card" style="margin-top:14px">
      <div class="row"><strong style="font-size:12.5px">上次生成</strong><span class="badge">${esc(g.mode)}</span></div>
      <div class="hint" style="margin-top:6px">
        edit_scope: <code class="mono">${esc(g.edit_scope)}</code><br>
        上下文只嵌入目标屏：<code class="mono">${esc((g.context_audit?.embedded_screen_ids || []).join(','))}</code>
      </div>
    </div>`;
}

function metaPanel(d) {
  return `
    <div class="card">
      <div class="kv"><span>screen_id</span><span><code class="mono">${esc(d.screen_id)}</code></span></div>
      <div class="kv"><span>状态</span><span>${esc(d.status)}</span></div>
      <div class="kv"><span>当前版本</span><span>v${d.current_version}</span></div>
      <div class="kv"><span>热区</span><span>${(d.anchors || []).map((a) => esc(a.hotspot_id)).join(', ') || '无'}</span></div>
      <div class="kv"><span>更新时间</span><span>${timeAgo(d.updated_at)}</span></div>
    </div>
    <div class="field" style="margin-top:14px"><label>屏幕名称</label><input class="input" id="metaTitle" value="${esc(d.title)}"></div>
    <div class="field"><label>备注</label><input class="input" id="metaRemark" value="${esc(d.remark || '')}"></div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      <button class="btn sm" id="metaSave">保存</button>
      <button class="btn sm" id="metaDup">复制屏幕</button>
      ${d.locked ? '<button class="btn sm" id="metaUnlock">解锁</button>' : '<button class="btn sm" id="metaLock">🔒 锁定</button>'}
      <button class="btn sm danger" id="metaDel">删除</button>
    </div>
    <p class="hint" style="margin-top:12px">锁定后 AI 写入与手动编辑都会被拒绝，但已有内容与关联边不受影响。</p>`;
}

function edgesPanel() {
  const edges = state.edges.filter((e) => e.source_screen_id === state.selected);
  const head = `<div class="row" style="margin-bottom:10px">
      <button class="btn sm primary" id="btnNLEdge">＋ 一句话建边</button>
      <span class="hint" style="margin-left:auto">只写 flow.json</span>
    </div>`;
  if (!edges.length)
    return `${head}<p class="hint">该屏还没有出边。切到「关联」模式，从热区拖到目标屏即可建边；也可以用一句话建边。</p>`;
  return `${head}<div class="edge-list">${edges.map(edgeCard).join('')}</div>`;
}

function edgeCard(e) {
  const src = state.screens.find((s) => s.screen_id === e.source_screen_id);
  const tgt = state.screens.find((s) => s.screen_id === e.target_screen_id);
  const bad = e.orphan?.hotspot_missing || e.orphan?.target_missing;
  return `
    <div class="edge-card ${bad ? 'orphan' : ''}" data-edge="${esc(e.edge_id)}">
      <div class="edge-route">
        <strong>${esc(src?.title || e.source_screen_id)}</strong>
        <code>${esc(e.source_hotspot_id)}</code> →
        <strong>${esc(tgt?.title || '（目标缺失）')}</strong>
      </div>
      <div class="edge-meta">
        <span>${esc(e.trigger || 'click')}</span>
        ${e.status === 'candidate' ? '<span class="badge pending">候选</span>' : ''}
        ${bad ? '<span class="warn-text">热区或目标已失效</span>' : ''}
        <div class="edge-actions">
          <button class="btn sm ghost" data-edit-edge="${esc(e.edge_id)}">改目标</button>
          <button class="btn sm ghost danger" data-del-edge="${esc(e.edge_id)}">删除</button>
        </div>
      </div>
    </div>`;
}

function bindTab(d) {
  const body = document.getElementById('tabBody');
  const scopeEl = document.getElementById('genScope');
  if (scopeEl)
    scopeEl.onchange = () => {
      state.genScope = scopeEl.value;
      if (state.genScope === 'screen') clearSelection({ silent: true });
      renderTab();
    };
  const pick = document.getElementById('btnPickNode');
  if (pick) pick.onclick = () => beginSelect(d);
  const clear = document.getElementById('btnClearSel');
  if (clear) clear.onclick = () => clearSelection();
  const gen = document.getElementById('btnGen');
  if (gen) gen.onclick = () => doGenerate(d, false);
  const genFull = document.getElementById('btnGenFull');
  if (genFull) genFull.onclick = () => doGenerate(d, true);
  const apply = document.getElementById('btnApply');
  if (apply) apply.onclick = () => applyPending(d);
  const reject = document.getElementById('btnReject');
  if (reject) reject.onclick = () => rejectPending(d);

  const saveMeta = document.getElementById('metaSave');
  if (saveMeta)
    saveMeta.onclick = async () => {
      try {
        await api.renameScreen(state.pid, d.screen_id, {
          title: document.getElementById('metaTitle').value.trim(),
          remark: document.getElementById('metaRemark').value.trim(),
        });
        await refreshScreens();
        await select(d.screen_id);
        applyScreens();
        toast('已保存', 'ok');
      } catch (e) {
        toast(errText(e), 'err');
      }
    };
  const lockBtn = document.getElementById('metaLock');
  if (lockBtn) lockBtn.onclick = () => toggleLock(d, true);
  const unlockBtn = document.getElementById('metaUnlock');
  if (unlockBtn) unlockBtn.onclick = () => toggleLock(d, false);
  const dup = document.getElementById('metaDup');
  if (dup)
    dup.onclick = async () => {
      try {
        const s = await api.duplicateScreen(state.pid, d.screen_id);
        await refreshScreens();
        applyScreens();
        select(s.screen_id);
        toast('已复制为新屏幕（独立版本历史）', 'ok');
      } catch (e) {
        toast(errText(e), 'err');
      }
    };
  const del = document.getElementById('metaDel');
  if (del) del.onclick = () => deleteScreen(d);

  body.querySelectorAll('[data-del-edge]').forEach((b) => (b.onclick = () => deleteEdge(b.dataset.delEdge)));
  body.querySelectorAll('[data-edit-edge]').forEach((b) => (b.onclick = () => openEdgePanel(b.dataset.editEdge)));
  const nl = document.getElementById('btnNLEdge');
  if (nl) nl.onclick = openNLEdge;
}

/* ---------------- 区域 / 组件选择 ---------------- */

function findNodeById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of Array.isArray(root.children) ? root.children : []) {
    const hit = findNodeById(c, id);
    if (hit) return hit;
  }
  return null;
}

function textOfNode(n) {
  if (!n) return '';
  if (n.props?.text) return String(n.props.text);
  return (n.children || []).map(textOfNode).filter(Boolean).join(' ');
}

function beginSelect(d) {
  if (state.mode !== 'edit') {
    toast('请先退出关联模式，再选择要修改的区域', 'err');
    return;
  }
  if (d.locked) {
    toast('该屏幕已锁定，无法选择与修改', 'err');
    return;
  }
  if (state.genScope === 'screen') state.genScope = 'region';
  state.selectMode = true;
  canvas.setSelectMode(true);
  renderTab();
  toast('在屏幕节点内点击要修改的区块', 'ok');
}

function clearSelection({ silent = false } = {}) {
  const sid = state.selection?.screen_id || state.selected;
  state.selection = null;
  state.selectMode = false;
  canvas.setSelectMode(false);
  canvas.setSelection(null, []);
  if (sid) canvas.setSelection(sid, []);
  if (!silent) renderTab();
}

/** 画布 iframe 内点击某个节点 → 收敛选区（FR-GEN-004 / FR-GEN-005） */
async function selectNode(sid, nodeId) {
  if (sid !== state.selected) await select(sid);
  const d = state.selectedDetail;
  const n = findNodeById(d?.doc?.root, nodeId);
  if (!n) return toast('没有找到被选中的节点，请刷新后重试', 'err');
  const label = (n.props?.text ? String(n.props.text) : textOfNode(n)).trim().slice(0, 40) || n.tag || nodeId;
  state.selection = { screen_id: sid, node_ids: [nodeId], label };
  if (state.genScope === 'screen') state.genScope = 'region';
  state.selectMode = true;
  canvas.setSelectMode(true);
  canvas.setSelection(sid, [nodeId]);
  if (state.sideTab !== 'generate') {
    state.sideTab = 'generate';
    renderSide();
  } else {
    renderTab();
  }
  toast(`已选中：${label}`, 'ok');
}

/* ---------------- 空间编辑（直接改文案） ---------------- */

/**
 * 画布 iframe 内双击文字 → 失焦 / Enter 提交一次。
 * 走 manual-patch，生成 manual_direct 版本（FR-SPACE-001 / DC-010）。
 * 锁定、待确认、生成中都在这里先拦一次；服务端仍会做最终校验。
 */
async function commitDirectEdit(sid, nodeId, text, original) {
  if (state.mode !== 'edit') return;
  const meta = state.screens.find((s) => s.screen_id === sid);
  if (!meta) return;
  if (meta.locked) return toast('该屏幕已锁定，禁止编辑', 'err');
  if (meta.pending) return toast('存在待确认的生成结果，请先接受或拒绝后再直接编辑', 'err');
  if (!nodeId || !text || text === original) return;
  if (state.busy) return toast('正在处理上一项操作，请稍候', 'err');

  state.busy = true;
  loading(true);
  try {
    const r = await api.manualPatch(state.pid, sid, {
      ops: [{ op: 'updateProps', target: { node_id: nodeId }, value: { text } }],
      edit_scope: 'component',
    });
    await refreshScreens();
    applyScreens();
    await select(sid);
    toast(`已保存人工修改（v${r.version}）`, 'ok');
  } catch (e) {
    // 失败时也要重绘：把 iframe 里已改但未落库的内容恢复成服务端版本
    await refreshScreens();
    applyScreens();
    await select(sid);
    toast(errText(e), 'err');
  } finally {
    state.busy = false;
    loading(false);
  }
}

/* ---------------- 生成流程 ---------------- */

async function doGenerate(d, forceFull) {
  const prompt = document.getElementById('genPrompt').value.trim();
  if (!prompt) return toast('请填写需求描述', 'err');
  const edit_scope = document.getElementById('genScope').value;
  if (!edit_scope) return toast('请选择生成范围', 'err');
  const selection =
    state.selection && state.selection.screen_id === d.screen_id
      ? { node_ids: state.selection.node_ids.slice() }
      : null;
  if (edit_scope !== 'screen' && !selection) {
    return toast('「区域 / 组件」范围需要先在屏幕上选择一个区块', 'err');
  }
  if (state.busy) return;
  state.busy = true;
  canvas.markGenerating(d.screen_id, true);
  loading(true);
  document.getElementById('btnGen').disabled = true;
  try {
    const res = await api.generate(state.pid, d.screen_id, {
      prompt,
      edit_scope: forceFull ? 'screen' : edit_scope,
      mode: forceFull ? 'full' : undefined,
      selection: forceFull ? null : selection,
    });
    state.lastGen = res;
    await refreshScreens();
    applyScreens();
    await select(d.screen_id);
    toast(`已生成待确认结果（${res.mode === 'full' ? '整屏' : '局部 patch'}），接受后才写入版本`, 'ok');
  } catch (e) {
    toast(errText(e), 'err');
    await refreshScreens();
    applyScreens();
  } finally {
    state.busy = false;
    loading(false);
    const b = document.getElementById('btnGen');
    if (b) b.disabled = false;
  }
}

async function applyPending(d) {
  try {
    const r = await api.applyPending(state.pid, d.screen_id);
    await refreshScreens();
    applyScreens();
    await select(d.screen_id);
    clearSelection({ silent: true });
    toast(`已接受，生成 v${r.version}`, 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

async function rejectPending(d) {
  try {
    await api.rejectPending(state.pid, d.screen_id);
    await refreshScreens();
    applyScreens();
    await select(d.screen_id);
    toast('已拒绝，屏幕内容未改变');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

/* ---------------- 版本 ---------------- */

async function renderVersions(d, el) {
  try {
    const { current_version, versions } = await api.versions(state.pid, d.screen_id);
    el.innerHTML = `
      <p class="hint" style="margin-top:0">每次接受生成/修改都会产生新版本。回滚只影响本屏。</p>
      <div style="margin-top:8px">
        ${versions
          .map(
            (v) => `
          <div class="ver-item ${v.version === current_version ? 'current' : ''}" data-ver="${v.version}">
            <span class="ver-num">v${v.version}</span>
            <span style="flex:1">
              ${esc(v.change_summary || v.label || v.kind)}
              ${sourceBadge(v)}
            </span>
            <span class="ver-meta">${timeAgo(v.created_at)}</span>
          </div>`
          )
          .join('')}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" id="btnUndo" ${d.locked || current_version <= 1 ? 'disabled' : ''}
          title="撤销最近一次变更（回到上一个版本）">↶ 撤销上一次变更</button>
      </div>
      <div id="verPreview" style="margin-top:14px"></div>`;
    el.querySelectorAll('[data-ver]').forEach((item) => {
      item.onclick = () => previewVersion(d, Number(item.dataset.ver), current_version);
    });
    const undo = el.querySelector('#btnUndo');
    if (undo) undo.onclick = () => undoLast(d);
  } catch (e) {
    el.innerHTML = `<p class="warn-text">${esc(errText(e))}</p>`;
  }
}

/** 版本来源标签（FR-SOURCE-001）：人工 / 内置生成器 / 大模型三类一眼可分 */
function sourceBadge(v) {
  const src = v.change_source || (v.kind === 'manual' ? 'manual_direct' : null);
  if (!src) return '';
  const meta = {
    manual_direct: ['manual', '人工'],
    builtin_rule: ['builtin', '内置生成器'],
    ai_patch: ['ai', 'AI'],
  }[src];
  if (!meta) return '';
  const cost = v.ai_cost === 0 ? ' · 0 token' : '';
  return `<span class="ver-src ${meta[0]}" title="${esc(`route_layer=${v.route_layer || '-'}${v.rule_id ? ` · ${v.rule_id}` : ''}`)}">${meta[1]}${cost}</span>`;
}

async function previewVersion(d, v, current) {
  const box = document.getElementById('verPreview');
  const rec = await api.version(state.pid, d.screen_id, v);
  box.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <strong style="font-size:13px">v${v} 预览</strong>
        ${v === current ? '<span class="badge v">当前版本</span>' : `<button class="btn sm" id="btnRollback" ${d.locked ? 'disabled' : ''}>回滚到此版本</button>`}
      </div>
      <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;height:420px;background:#fff">
        <iframe id="verFrame" style="border:0;width:100%;height:100%" sandbox="allow-same-origin"></iframe>
      </div>
      <div class="hint" style="margin-top:8px">来源：${esc(rec.source?.kind || '')} ${rec.source?.prompt ? `· ${esc(rec.source.prompt.slice(0, 40))}` : ''}</div>
      ${
        v !== current
          ? `<div class="row" style="margin-top:8px"><button class="btn sm" id="btnDiff">与 v${current} 对比</button></div>`
          : ''
      }
    </div>`;
  box.querySelector('#verFrame').srcdoc = docToSrcdoc(rec.doc, { interactive: false });
  const rb = box.querySelector('#btnRollback');
  if (rb)
    rb.onclick = async () => {
      const ok = await confirmDialog({
        title: '确认回滚',
        message: `将「${esc(d.title)}」回滚到 v${v}？<br><br>此操作只影响当前屏幕，其他屏幕与所有关联边不受影响。回滚本身不会删除任何历史版本。`,
        okText: '回滚',
      });
      if (!ok) return;
      try {
        await api.rollback(state.pid, d.screen_id, v);
        await refreshScreens();
        applyScreens();
        await select(d.screen_id);
        toast(`已回滚到 v${v}`, 'ok');
      } catch (e) {
        toast(errText(e), 'err');
      }
    };
  const diffBtn = box.querySelector('#btnDiff');
  if (diffBtn) diffBtn.onclick = () => openDiffModal(d, v, current);
}

/** 版本对比：并排渲染 + 节点级高亮（FR-VER-004） */
async function openDiffModal(d, a, b) {
  try {
    const [ra, rb, dd] = await Promise.all([
      api.version(state.pid, d.screen_id, a),
      api.version(state.pid, d.screen_id, b),
      api.diff(state.pid, d.screen_id, a, b),
    ]);
    const detail = dd.details || { added: [], removed: [], changed: [] };
    const mapA = {};
    const mapB = {};
    for (const x of detail.removed) mapA[x.node_id] = '#dc2626';
    for (const x of detail.added) mapB[x.node_id] = '#16a34a';
    for (const x of detail.changed) {
      mapA[x.node_id] = '#f59e0b';
      mapB[x.node_id] = '#f59e0b';
    }
    const items = [
      ...detail.added.map((x) => ({ kind: 'added', x })),
      ...detail.removed.map((x) => ({ kind: 'removed', x })),
      ...detail.changed.map((x) => ({ kind: 'changed', x })),
    ];
    const m = modal({
      title: `版本对比 v${a} ↔ v${b}`,
      width: 'min(1120px,96vw)',
      body: `
        <div class="diff-legend">
          <span><i class="sw added"></i>新增 ${dd.added.length}</span>
          <span><i class="sw removed"></i>删除 ${dd.removed.length}</span>
          <span><i class="sw changed"></i>修改 ${dd.changed.length}</span>
          <span class="hint">点击下方条目可在两侧定位高亮</span>
        </div>
        <div class="diff-panes">
          <div class="diff-pane">
            <div class="diff-pane-head">v${a} <span class="hint">${esc(ra.source?.label || ra.source?.kind || '')}</span></div>
            <iframe id="diffA" class="diff-frame" sandbox="allow-same-origin"></iframe>
          </div>
          <div class="diff-pane">
            <div class="diff-pane-head">v${b} <span class="hint">${esc(rb.source?.label || rb.source?.kind || '')}</span></div>
            <iframe id="diffB" class="diff-frame" sandbox="allow-same-origin"></iframe>
          </div>
        </div>
        <div class="diff-list" style="max-height:180px;overflow:auto">
          ${
            items
              .map(({ kind, x }) => {
                const n = x.after || x;
                const before = kind === 'changed' ? x.before?.text || '' : '';
                const after = kind === 'changed' ? x.after?.text || '' : x.text || '';
                return `<div class="diff-item ${kind}" data-node="${esc(x.node_id)}">
                  <code class="mono">${kind === 'added' ? '+' : kind === 'removed' ? '−' : '~'}</code>
                  <small>${esc(x.node_id)} · ${esc(n.tag || '')}</small>
                  ${
                    kind === 'changed'
                      ? `<span class="diff-text"><del>${esc(before.slice(0, 60))}</del> → <ins>${esc(after.slice(0, 60))}</ins></span>`
                      : `<span class="diff-text">${esc(after.slice(0, 80))}</span>`
                  }
                </div>`;
              })
              .join('') || '<div class="hint">两个版本没有结构差异</div>'
          }
        </div>
        <p class="hint" style="margin-bottom:0">对比只读取版本快照，不会改动任何屏幕内容。</p>`,
    });
    const frameA = m.bodyEl.querySelector('#diffA');
    const frameB = m.bodyEl.querySelector('#diffB');
    const paint = (focusId) => {
      const ha = focusId ? { ...mapA, [focusId]: '#2563eb' } : mapA;
      const hb = focusId ? { ...mapB, [focusId]: '#2563eb' } : mapB;
      frameA.srcdoc = docToSrcdoc(ra.doc, { highlightMap: ha });
      frameB.srcdoc = docToSrcdoc(rb.doc, { highlightMap: hb });
    };
    paint(null);
    m.bodyEl.querySelectorAll('[data-node]').forEach((el) => {
      el.onclick = () => paint(el.dataset.node);
    });
  } catch (e) {
    toast(errText(e), 'err');
  }
}

async function undoLast(d) {
  const ok = await confirmDialog({
    title: '撤销上一次变更',
    message: '将当前屏幕退回到上一个版本？<br><br>只影响本屏，不删除历史版本，也不影响其他屏幕与关联边。',
    okText: '撤销',
  });
  if (!ok) return;
  try {
    const r = await api.undo(state.pid, d.screen_id);
    await refreshScreens();
    applyScreens();
    await select(d.screen_id);
    toast(`已撤销，当前 v${r.version}`, 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

/* ---------------- 锁定 / 删除 ---------------- */

async function toggleLock(d, lock) {
  try {
    if (lock) await api.lock(state.pid, d.screen_id, { reason: '用户在画布锁定' });
    else {
      const reason = prompt('解锁原因（会记入审计）') ?? '';
      await api.unlock(state.pid, d.screen_id, { reason });
    }
    await refreshScreens();
    applyScreens();
    await select(d.screen_id);
    toast(lock ? '已锁定' : '已解锁', 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

async function deleteScreen(d) {
  try {
    await api.deleteScreen(state.pid, d.screen_id, {});
    await afterDelete(d);
    toast('已删除', 'ok');
  } catch (e) {
    if (e.code === 'CONFLICT' && e.detail?.code === 'EDGES_EXIST') {
      const edges = e.detail.related_edges || [];
      const m = modal({
        title: '该屏幕存在关联边',
        body: `<p style="margin-top:0">删除「${esc(d.title)}」会影响 ${edges.length} 条关联边：</p>
          <div class="diff-list">${edges
            .map((x) => `<div class="diff-item"><code class="mono">${esc(x.source.slice(-6))}</code> → <code class="mono">${esc(x.target.slice(-6))}</code></div>`)
            .join('')}</div>
          <p class="hint">请选择处理方式。系统不会擅自删除你的连线。</p>`,
        footer: `<button class="btn" data-close>取消</button>
                 <button class="btn" data-keep>保留为孤儿边</button>
                 <button class="btn danger" data-del>一并删除边</button>`,
      });
      m.footEl.querySelector('[data-del]').onclick = async () => {
        m.close();
        await finishDelete(d, 'delete_edges');
      };
      m.footEl.querySelector('[data-keep]').onclick = async () => {
        m.close();
        await finishDelete(d, 'keep_edges_as_orphan');
      };
      return;
    }
    toast(errText(e), 'err');
  }
}

/** 删除成功后必须清掉选中态并重拉清单，否则画布/侧栏仍停留在已删除的屏 */
async function afterDelete(d) {
  if (state.selected === d.screen_id) state.selected = null;
  state.selectedDetail = null;
  state.selectMode = false;
  canvas.setSelectMode(false);
  if (state.selection?.screen_id === d.screen_id) state.selection = null;
  canvas.setSelection(d.screen_id, []);
  await refreshScreens();
  applyScreens();
}

async function finishDelete(d, action) {
  try {
    await api.deleteScreen(state.pid, d.screen_id, { edge_action: action });
    await afterDelete(d);
    toast('已删除', 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

/* ---------------- 关联 ---------------- */

function setMode(mode) {
  state.mode = mode;
  if (mode !== 'edit') clearSelection({ silent: true });
  if (mode === 'edit') state.genScope = 'screen';
  document.querySelectorAll('#modeSeg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'flow') {
    state.sideTab = 'edges';
    loadEdgesThenRender();
  } else {
    state.sideTab = 'generate';
    renderSide();
  }
  canvas.setMode(mode);
  renderCanvas();
  if (mode === 'flow') setTimeout(() => canvas.fit(), 60);
}

async function loadEdgesThenRender() {
  await refreshScreens();
  decorateAnchors();
  renderCanvas();
  renderSide();
}

async function connectEdge(payload) {
  try {
    const e = await api.createEdge(state.pid, payload);
    await refreshScreens();
    decorateAnchors();
    renderCanvas();
    renderSide();
    toast('已建边：' + payload.source_hotspot_id, 'ok');
    return e;
  } catch (err) {
    toast(errText(err), 'err');
  }
}

async function deleteEdge(id) {
  const ok = await confirmDialog({ title: '删除关联边', message: '删除连接不会影响任何屏幕内容与版本。', danger: true, okText: '删除' });
  if (!ok) return;
  try {
    await api.deleteEdge(state.pid, id);
    await refreshScreens();
    decorateAnchors();
    renderCanvas();
    renderSide();
    toast('已删除关联边', 'ok');
  } catch (e) {
    toast(errText(e), 'err');
  }
}

function openEdgePanel(edgeId) {
  const e = state.edges.find((x) => x.edge_id === edgeId);
  if (!e) return;
  const src = state.screens.find((s) => s.screen_id === e.source_screen_id);
  const m = modal({
    title: '关联边属性',
    body: `
      <div class="card" style="margin-bottom:14px">
        <div class="kv"><span>源屏幕</span><span>${esc(src?.title || '')}</span></div>
        <div class="kv"><span>热区</span><span><code class="mono">${esc(e.source_hotspot_id)}</code></span></div>
        <div class="kv"><span>edge_id</span><span><code class="mono">${esc(e.edge_id)}</code></span></div>
      </div>
      <div class="field"><label>目标屏幕</label>
        <select class="select" id="epTarget">
          ${state.screens
            .filter((s) => s.screen_id !== e.source_screen_id)
            .map((s) => `<option value="${esc(s.screen_id)}" ${s.screen_id === e.target_screen_id ? 'selected' : ''}>${esc(s.title)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field"><label>触发方式</label>
        <select class="select" id="epTrigger">
          <option value="click" ${e.trigger === 'click' ? 'selected' : ''}>点击</option>
          <option value="auto" ${e.trigger === 'auto' ? 'selected' : ''}>自动</option>
        </select>
      </div>
      <div class="field"><label>备注</label><input class="input" id="epNote" value="${esc(e.note || '')}"></div>
      <p class="hint">修改关联只写入 flow.json，不会触发任何屏幕重生成。</p>`,
    footer: `<button class="btn danger" data-del>删除</button><span style="flex:1"></span>
             <button class="btn" data-close>取消</button><button class="btn primary" data-ok>保存</button>`,
  });
  m.footEl.querySelector('[data-ok]').onclick = async () => {
    try {
      await api.updateEdge(state.pid, e.edge_id, {
        target_screen_id: m.bodyEl.querySelector('#epTarget').value,
        trigger: m.bodyEl.querySelector('#epTrigger').value,
        note: m.bodyEl.querySelector('#epNote').value,
      });
      m.close();
      await refreshScreens();
      decorateAnchors();
      renderCanvas();
      renderSide();
      toast('已保存（未触发重生成）', 'ok');
    } catch (err) {
      toast(errText(err), 'err');
    }
  };
  m.footEl.querySelector('[data-del]').onclick = () => {
    m.close();
    deleteEdge(e.edge_id);
  };
}

/** 自然语言建边 */
async function openNLEdge() {
  const m = modal({
    title: '用一句话建边',
    body: `
      <div class="field"><label>描述跳转关系</label>
        <textarea class="textarea" id="nlText" placeholder="例如：在登录页点登录按钮跳到审批列表"></textarea>
        <span class="hint">系统只产出候选边，需你确认后才会保存。</span>
      </div>
      <div id="nlResult"></div>`,
    footer: `<button class="btn" data-close>关闭</button><button class="btn primary" data-ok>解析</button>`,
  });
  m.footEl.querySelector('[data-ok]').onclick = async () => {
    const text = m.bodyEl.querySelector('#nlText').value.trim();
    if (!text) return toast('请输入描述', 'err');
    try {
      const c = await api.proposeEdge(state.pid, { text });
      const box = m.bodyEl.querySelector('#nlResult');
      const src = state.screens.find((s) => s.screen_id === c.source_screen_id);
      const tgt = state.screens.find((s) => s.screen_id === c.target_screen_id);
      box.innerHTML = `
        <div class="card" style="border-color:#ddd6fe;background:#faf8ff">
          <div class="edge-route"><strong>${esc(src?.title)}</strong> <code>${esc(c.source_hotspot_id)}</code> → <strong>${esc(tgt?.title)}</strong></div>
          <div class="hint" style="margin-top:6px">${esc(c.rationale)}</div>
          <div class="row" style="margin-top:10px"><button class="btn sm primary" id="nlConfirm">确认保存</button></div>
        </div>`;
      box.querySelector('#nlConfirm').onclick = async () => {
        try {
          await api.confirmEdge(state.pid, c);
          m.close();
          await loadEdgesThenRender();
          toast('候选边已确认（未触发重生成）', 'ok');
        } catch (e) {
          toast(errText(e), 'err');
        }
      };
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
}

/* ---------------- 预览 ---------------- */

async function openPreview() {
  try {
    const data = await api.preview(state.pid, state.selected || undefined);
    const width = data.project.device.width;
    const height = data.project.device.height;
    const stack = [];
    let current = data.start;

    const overlay = document.createElement('div');
    overlay.className = 'preview-overlay';
    overlay.innerHTML = `
      <div class="preview-bar">
        <button class="btn sm" id="pvBack">‹ 返回</button>
        <span id="pvTitle"></span>
        <span class="pill" id="pvCount"></span>
        <button class="btn sm" id="pvRestart">从首页重来</button>
        <button class="btn sm" id="pvClose">关闭</button>
      </div>
      <div class="preview-device" style="width:${width}px;height:${height}px">
        <iframe id="pvFrame" sandbox="allow-same-origin allow-scripts"></iframe>
        <div class="preview-toast" id="pvToast"></div>
      </div>`;
    document.body.appendChild(overlay);

    const frame = overlay.querySelector('#pvFrame');
    const titleEl = overlay.querySelector('#pvTitle');
    const countEl = overlay.querySelector('#pvCount');
    const toastEl = overlay.querySelector('#pvToast');

    const showToast = (msg) => {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
    };

    const render = (sid, push = true) => {
      const s = data.screens.find((x) => x.screen_id === sid);
      if (!s) return;
      if (push && current && current !== sid) stack.push(current);
      current = sid;
      const edges = data.edges.filter((e) => e.source_screen_id === sid && (e.status || 'confirmed') !== 'candidate');
      // 复用画布渲染器，保留其基础样式；只追加交互脚本。
      // 之前手写 head 会丢掉 BASE 里的布局重置，导致不同浏览器预览不一致。
      const html = docToSrcdoc(s.doc, { interactive: true });
      frame.srcdoc = html.replace(
        '</body>',
        `<script>
document.addEventListener('click',function(ev){
  var el=ev.target.closest('[data-anchor]');
  if(!el)return;
  ev.preventDefault();ev.stopPropagation();
  window.parent.postMessage({type:'hotspot',anchor:el.getAttribute('data-anchor')},'*');
});
</script></body>`
      );
      const s2 = data.screens.find((x) => x.screen_id === sid);
      titleEl.textContent = s2.title;
      countEl.textContent = `${data.screens.findIndex((x) => x.screen_id === sid) + 1} / ${data.screens.length}`;
      overlay.querySelector('#pvBack').disabled = stack.length === 0;
      frame.dataset.edges = JSON.stringify(edges);
    };

    window.__pvHandler = (ev) => {
      const d = ev.data;
      if (!d || d.type !== 'hotspot') return;
      const edges = JSON.parse(frame.dataset.edges || '[]');
      const e = edges.find((x) => x.source_hotspot_id === d.anchor);
      if (!e) {
        // FR-PREVIEW-005：无关联热区给出提示，绝不乱跳
        showToast(`热区「${d.anchor}」尚未配置关联`);
        return;
      }
      render(e.target_screen_id, true);
    };
    window.addEventListener('message', window.__pvHandler);

    overlay.querySelector('#pvBack').onclick = () => {
      const prev = stack.pop();
      if (prev) render(prev, false);
    };
    overlay.querySelector('#pvClose').onclick = () => {
      window.removeEventListener('message', window.__pvHandler);
      overlay.remove();
    };
    const restart = () => {
      stack.length = 0;
      current = null;
      render(data.start, false);
    };
    overlay.querySelector('#pvRestart').onclick = restart;

    render(data.start, false);
  } catch (e) {
    toast(errText(e), 'err');
  }
}

/* ---------------- 导出 / 审计 ---------------- */

async function doExport() {
  try {
    loading(true);
    const r = await api.exportProto(state.pid, { start: state.selected || undefined, name: `${state.project.name}-${Date.now()}` });
    loading(false);
    modal({
      title: '导出成功',
      body: `<p style="margin-top:0">已导出可点击原型（${r.screens} 屏，${r.edges} 条关联）。</p>
        <div class="card"><div class="kv"><span>目录</span><span><code class="mono">${esc(r.dir)}</code></span></div>
        <div class="kv"><span>入口</span><span><code class="mono">index.html</code></span></div>
        <div class="kv"><span>页面数据</span><span><code class="mono">data/screens.json</code></span></div>
        <div class="kv"><span>关联数据</span><span><code class="mono">data/flow.json</code></span></div></div>
        <p class="hint">该导出物不依赖后端，直接打开 index.html 即可点击走通流程。</p>`,
    });
  } catch (e) {
    loading(false);
    toast(errText(e), 'err');
  }
}

async function openAudit() {
  try {
    const { audits, jobs } = await api.audit(state.pid);
    const alerts = audits.filter((a) => a.level === 'alert');
    modal({
      title: '审计日志',
      width: 'min(760px,94vw)',
      body: `
        <h4 style="margin-top:0">生成任务（${jobs.length}）</h4>
        <div class="edge-list">${jobs
          .slice()
          .reverse()
          .slice(0, 12)
          .map(
            (j) => `<div class="edge-card">
              <div class="edge-route"><code class="mono">${esc(j.job_id)}</code> <span class="badge">${esc(j.status)}</span></div>
              <div class="edge-meta">
                <span>target: <code class="mono">${esc(j.target_screen_id)}</code></span>
                <span>scope: ${esc(j.edit_scope)}</span>
                <span>上下文嵌入: ${esc((j.context_audit?.embedded_screen_ids || []).join(','))}</span>
              </div>
            </div>`
          )
          .join('') || '<div class="hint">暂无</div>'}</div>
        <h4>告警（${alerts.length}）</h4>
        <div class="diff-list">${alerts
          .slice(-10)
          .map((a) => `<div class="diff-item" style="border-color:var(--danger)"><code class="mono">${esc(a.action)}</code> <small>${timeAgo(a.at)}</small></div>`)
          .join('') || '<div class="hint">无告警</div>'}</div>
        <h4>最近操作（${audits.length}）</h4>
        <div class="diff-list">${audits
          .slice(-25)
          .reverse()
          .map(
            (a) => `<div class="diff-item"><code class="mono">${esc(a.action)}</code> ${esc(a.object_id || '')} <small>${timeAgo(a.at)} · ${esc(a.result || '')}</small></div>`
          )
          .join('')}</div>`,
    });
  } catch (e) {
    toast(errText(e), 'err');
  }
}

boot();
