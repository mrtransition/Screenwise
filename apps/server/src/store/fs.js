import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 原子写：先写临时文件再 rename，避免读到半截 JSON。
 * NFR-008（Patch 原子性）在文件层的第一道保障。
 */
export async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const payload = JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    // 失败时必须清掉临时文件，否则版本目录里会留下“半截”产物（AC-318）
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按 key 串行化写操作：同一屏幕的写入排队，不同屏幕互不阻塞。
 * 这是"存储隔离"的并发层面保障（同一屏不会出现交错写）。
 */
export class KeyedQueue {
  #chains = new Map();

  run(key, task) {
    const prev = this.#chains.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    // 链条尾部吞掉异常，避免一次失败让后续任务全部 reject
    this.#chains.set(
      key,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }
}
