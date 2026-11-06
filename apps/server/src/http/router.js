import { AppError } from '../errors.js';

/** 极简路由：路径模板支持 :param，够用且零依赖 */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:([\w]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$'
    );
    routes.push({ method, re, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    put: (p, h) => add('PUT', p, h),
    del: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) {
          const params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          return { handler: r.handler, params };
        }
      }
      return null;
    },
  };
}

export async function readBody(req, limit = 8 * 1024 * 1024) {
  const raw = await readRawBody(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError({ code: 'BAD_JSON', status: 400 }, '请求体不是合法 JSON');
  }
}

/** 读取原始字节（导入接口需要 50MB 上限与 multipart 解析） */
export async function readRawBody(req, limit = 50 * 1024 * 1024, code = 'PAYLOAD_TOO_LARGE') {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      throw new AppError({ code, status: 413 }, `请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * multipart 头按 latin1 切分（保证字节不丢），但 filename / name 在浏览器里
 * 多为 UTF-8 编码——直接当 latin1 用会让「项目.json」变成「é¡¹ç®.json」。
 * 这里按 UTF-8 重新解码；不是合法 UTF-8 时退回原值，避免破坏 latin1 文件名。
 */
function decodeHeaderText(text) {
  const value = String(text ?? '');
  if (!/[^\x00-\x7f]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

/** RFC 5987：优先取 `filename*=UTF-8''...`，它对非 ASCII 文件名最准确 */
function filenameStar(head) {
  const m = /filename\*\s*=\s*([\w!#$&+.^`|~-]+)'[^']*'([^;\r\n]+)/i.exec(head);
  if (!m) return null;
  if (!/^utf-8$/i.test(m[1])) return null;
  try {
    return decodeURIComponent(m[2].trim().replace(/^"|"$/g, ''));
  } catch {
    return null;
  }
}

/**
 * 极简 multipart/form-data 解析（单文件字段 + 普通文本字段），零依赖。
 * 只用于项目导入；不处理嵌套 multipart、不保留文件头。
 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) throw new AppError({ code: 'BAD_REQUEST', status: 400 }, 'multipart 缺少 boundary');
  const boundary = `--${m[1] || m[2]}`.trim();
  const raw = buffer.toString('latin1');
  const fields = {};
  const files = [];
  const parts = raw.split(boundary);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--') continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    let body = part.slice(idx + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const nameMatch = /name="([^"]*)"/i.exec(head);
    const fileMatch = /filename="([^"]*)"/i.exec(head);
    if (!nameMatch) continue;
    const name = decodeHeaderText(nameMatch[1]);
    if (fileMatch) files.push({ field: name, filename: decodeHeaderText(filenameStar(head) ?? fileMatch[1]), buffer: Buffer.from(body, 'latin1') });
    else fields[name] = Buffer.from(body, 'latin1').toString('utf8');
  }
  return { fields, files };
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
