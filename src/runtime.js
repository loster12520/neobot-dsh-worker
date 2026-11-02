/** 命令执行器：把 NeoBot 下发的协议命令落到任务登记处 + DSH 会话适配层。 */

import { WorkerHealth } from './health.js';

const SUMMARY_LIMIT = 300;
const ACTIVE_STATUSES = new Set([
  'queued',
  'dispatched',
  'running',
  'waiting_permission',
  'cancelling',
]);

export class WorkerRuntime {
  /**
   * @param {object} options
   * @param {import('./sync.js').SyncClient} options.client
   * @param {import('./tasks.js').TaskRegistry} options.registry
   * @param {import('./session-adapter.js').DshSessionAdapter} options.sessions
   * @param {import('./config.js').WorkerConfig} options.config
   * @param {object} [options.logger]
   */
  constructor({ client, registry, sessions, config, logger = console }) {
    this.client = client;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
    this.logger = logger;
    this.health = new WorkerHealth({ config, registry, client, sessions });

    // 会话事件与审批请求都由 adapter 回调进来；这里统一转成协议报告。
    this.sessions.onEvent = (taskId, event) => this._onSessionEvent(taskId, event);
    this.sessions.onPermission = (taskId, request) =>
      this.report('perm.request', taskId, request);
  }

  async handle(command) {
    this.logger.info?.(`[neobot-worker] ${command.kind} ${command.task_id} (${command.id})`);
    switch (command.kind) {
      case 'daemon.hello':
        return this._hello();
      case 'task.dispatch':
        return this._open(command);
      case 'task.input':
        return this._input(command);
      case 'task.cancel':
        return this._cancel(command);
      case 'task.status':
        return this._status(command);
      case 'perm.answer':
        return this._answerPermission(command);
      default:
        throw new Error(`unsupported command kind: ${command.kind}`);
    }
  }

  /** 上报语义事件；由 session 事件适配层调用。 */
  report(kind, taskId, payload = {}) {
    this.client.enqueueReport(kind, taskId, payload);
  }

  /** 巡检：把长时间没有事件的任务标 stale 并上报一条卡点。 */
  reap(nowSeconds = Date.now() / 1000) {
    const stale = this.registry.markStale(nowSeconds, this.config.taskStaleSeconds);
    for (const task of stale) {
      this.report('task.event', task.task_id, {
        phase: 'blocker',
        text: `超过 ${this.config.taskStaleSeconds}s 没有收到 Worker 事件，已标记 stale`,
      });
    }
    return stale;
  }

  /**
   * 启动对账：daemon 重启后本地没有 Session 映射，旧任务不可能再继续。
   * 主动报 failed，避免 NeoBot 侧一直停在 running/dispatched。
   */
  reconcile() {
    const alive = new Set(this.sessions.aliveTaskIds?.() || []);
    const activeStates = new Set(['queued', 'dispatched', 'running', 'waiting_permission']);
    for (const task of this.registry.list()) {
      if (!activeStates.has(task.status)) continue;
      if (alive.has(task.task_id)) continue;
      this.registry.update(task.task_id, {
        status: 'failed',
        summary: 'daemon 重启，旧 Worker 会话未恢复',
      });
      this.report('task.done', task.task_id, {
        outcome: 'failed',
        summary: 'daemon 重启，旧 Worker 会话未恢复；请重新派发',
      });
    }
  }

  dispose() {
    this.sessions.dispose?.();
  }

  async _hello() {
    this.report('daemon.health', 'daemon', this.health.snapshot());
    for (const task of this.registry.list()) {
      this.report('task.event', task.task_id, {
        phase: 'stage',
        text: `daemon 已连接，本地任务状态：${task.status}`,
      });
    }
  }

  async _open(command) {
    const { cwd, prompt, mode } = command.payload || {};
    if (!cwd || !prompt) {
      throw new Error('task.dispatch requires payload.cwd and payload.prompt');
    }
    const taskId = command.task_id;
    if (this.registry.get(taskId)) {
      this.report('task.event', taskId, { phase: 'stage', text: '任务已存在，忽略重复 task.dispatch' });
      return;
    }
    const record = this.registry.create({
      taskId,
      cwd,
      mode: mode || 'write',
      prompt,
      owner: command.payload.owner || '',
    });
    this.report('task.event', taskId, { phase: 'stage', text: 'Worker 已接收任务' });
    try {
      const opened = await this.sessions.open({ taskId, cwd: record.cwd });
      this.registry.update(taskId, { status: 'running', session_id: opened.sessionId });
      this.report('task.event', taskId, {
        phase: 'stage',
        text: 'Worker Session 已启动',
        data: { session_id: opened.sessionId },
      });
      await this.sessions.prompt(taskId, prompt);
    } catch (error) {
      this.registry.update(taskId, { status: 'failed', summary: String(error?.message || error) });
      this.report('task.done', taskId, {
        outcome: 'failed',
        summary: `Worker 启动失败：${error?.message || error}`,
      });
    }
  }

  async _input(command) {
    const taskId = command.task_id;
    const record = this.registry.get(taskId);
    if (!record) throw new Error(`task.input for unknown task ${taskId}`);
    const text = String(command.payload?.text || '').trim();
    if (!text) throw new Error('task.input requires payload.text');
    const mode = command.payload?.mode === 'queue' ? 'queue' : 'steer';
    this.registry.touch(taskId, { last_event_at: Date.now() / 1000 });

    if (record.status === 'running' || record.status === 'waiting_permission') {
      if (mode === 'steer') await this.sessions.steer(taskId, text);
      else await this.sessions.prompt(taskId, text);
      this.report('task.event', taskId, {
        phase: 'stage',
        text: mode === 'steer' ? '补充信息已下发（下一步生效）' : '补充信息已排队',
      });
      return;
    }
    if (record.status === 'dispatched' || record.status === 'queued') {
      await this.sessions.prompt(taskId, text);
      this.registry.update(taskId, { status: 'running' });
      this.report('task.event', taskId, { phase: 'stage', text: '任务已开始执行' });
      return;
    }
    this.report('task.event', taskId, {
      phase: 'stage',
      text: `任务当前状态 ${record.status}，忽略 input`,
    });
  }

  async _cancel(command) {
    const taskId = command.task_id;
    const record = this.registry.get(taskId);
    if (!record) throw new Error(`task.cancel for unknown task ${taskId}`);
    await this.sessions.cancel(taskId, command.payload?.reason || 'user');
    this.registry.update(taskId, { status: 'cancelled' });
    this.report('task.done', taskId, {
      outcome: 'cancelled',
      summary: command.payload?.reason || '已按用户要求取消',
    });
  }

  async _status(command) {
    const taskId = command.task_id;
    const record = this.registry.get(taskId);
    if (!record) throw new Error(`task.status for unknown task ${taskId}`);
    const session = await this.sessions.status(taskId);
    this.report('task.event', taskId, {
      phase: 'stage',
      text: `状态：${record.status}`,
      data: { session, record },
    });
  }

  async _answerPermission(command) {
    const taskId = command.task_id;
    const { request_id: requestId, allow } = command.payload || {};
    if (!requestId) throw new Error('perm.answer requires payload.request_id');
    await this.sessions.answerPermission(taskId, requestId, Boolean(allow));
    this.registry.touch(taskId, { status: 'running' });
    this.report('task.event', taskId, {
      phase: 'stage',
      text: allow ? '审批已放行（one-shot）' : '审批已拒绝',
    });
  }

  /** DSH 会话事件 → 协议报告。 */
  _onSessionEvent(taskId, event) {
    const record = this.registry.get(taskId);
    if (!record || !ACTIVE_STATUSES.has(record.status)) return;
    const now = Date.now() / 1000;
    if (event.type === 'start') {
      this.registry.update(taskId, { status: 'running', last_event_at: now });
      this.report('task.event', taskId, { phase: 'stage', text: 'Worker 开始执行' });
      return;
    }
    if (event.type === 'assistant') {
      const text = String(event.text || '').trim();
      if (!text) return;
      this.registry.update(taskId, { last_event_at: now, summary: clip(text) });
      this.report('task.event', taskId, { phase: 'progress', text: clip(text) });
      return;
    }
    if (event.type === 'tool_error') {
      this.registry.update(taskId, { last_event_at: now });
      this.report('task.event', taskId, {
        phase: 'blocker',
        text: `工具报错：${clip(event.text || '')}`,
      });
      return;
    }
    if (event.type === 'done') {
      const reason = String(event.reason || '').toLowerCase();
      let outcome = 'completed';
      if (reason.includes('cancel')) outcome = 'cancelled';
      else if (reason.includes('error') || reason.includes('fail')) outcome = 'failed';
      this.registry.update(taskId, {
        status: outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'done',
        summary: clip(event.summary || ''),
        last_event_at: now,
      });
      this.report('task.done', taskId, {
        outcome,
        summary: clip(event.summary || '') || `本轮结束（${reason || 'end_turn'}）`,
        artifacts: [],
      });
    }
  }
}

function clip(text, limit = SUMMARY_LIMIT) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
