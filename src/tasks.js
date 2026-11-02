/** 任务登记处：task_id → 本地会话与状态；JSON 原子落盘，daemon 重启后可对账。 */

import fs from 'node:fs';
import path from 'node:path';

export class TaskRegistry {
  /** @param {{file: string, logger?: object}} options */
  constructor({ file, logger = console }) {
    this.file = file;
    this.logger = logger;
    this._tasks = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of Array.isArray(raw?.tasks) ? raw.tasks : []) {
        if (item?.task_id) this._tasks.set(String(item.task_id), item);
      }
    } catch (error) {
      this.logger.warn?.(`[neobot-worker] task registry load failed: ${error?.message || error}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tasks: [...this._tasks.values()] }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  create({ taskId, cwd, mode = 'write', prompt = '', owner = '' }) {
    const now = Date.now() / 1000;
    const record = {
      task_id: taskId,
      cwd,
      mode,
      prompt,
      owner,
      status: 'queued',
      session_id: '',
      created_at: now,
      updated_at: now,
      last_event_at: now,
      summary: '',
      artifacts: [],
    };
    this._tasks.set(taskId, record);
    this.save();
    return record;
  }

  get(taskId) {
    return this._tasks.get(String(taskId)) || null;
  }

  update(taskId, patch) {
    const record = this.get(taskId);
    if (!record) return null;
    Object.assign(record, patch, { updated_at: Date.now() / 1000 });
    this.save();
    return record;
  }

  touch(taskId, patch = {}) {
    return this.update(taskId, { ...patch, last_event_at: Date.now() / 1000 });
  }

  list() {
    return [...this._tasks.values()];
  }

  remove(taskId) {
    const removed = this._tasks.delete(String(taskId));
    if (removed) this.save();
    return removed;
  }

  /** 超时未收到事件的运行中任务标 stale；返回被标记的任务。 */
  markStale(nowSeconds, staleSeconds) {
    const stale = [];
    for (const record of this._tasks.values()) {
      if (!['starting', 'running', 'waiting_permission'].includes(record.status)) continue;
      if (nowSeconds - (record.last_event_at || 0) < staleSeconds) continue;
      record.status = 'stale';
      record.updated_at = nowSeconds;
      stale.push(record);
    }
    if (stale.length) this.save();
    return stale;
  }
}
