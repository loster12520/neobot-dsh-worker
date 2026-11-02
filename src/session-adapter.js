/**
 * DSH 会话适配层：把协议命令翻译成进程内 Session/Agent 调用。
 *
 * 依赖（均在 DSH 0.2.1-rc.2 的 Host 服务里）：
 * - ctx.sessionController.create/resolveAgent/rename
 * - ctx.permissionPresets.set
 * - ctx.on('session/event') / ctx.on('approval/request')
 *
 * 这个文件是整插件唯一依赖 DSH 内部 API 的地方；DSH 升级只改这里。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SessionAdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionAdapterError';
  }
}

export class DshSessionAdapter {
  /**
   * @param {object} options
   * @param {object} options.ctx DSH 插件 Context
   * @param {import('./config.js').WorkerConfig} options.config
   * @param {object} [options.logger]
   */
  constructor({ ctx, config, logger = console }) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this._sessions = new Map(); // task_id -> { sessionId, agent, running, lastAssistant, counter }
    this._bySession = new Map(); // sessionId -> task_id
    this._byAgent = new Map(); // agent -> task_id
    this._approvals = new Map(); // request_id -> { resolve, timer, taskId }
    this._disposers = [];
    this._disposed = false;
    this._debugFile = path.join(config.stateDir, 'adapter-debug.log');
    this._debug('adapter constructed');

    /** 由 runtime 注入：会话事件回调。 */
    this.onEvent = null;
    /** 由 runtime 注入：审批请求回调（上报 perm.request）。 */
    this.onPermission = null;

    this._listen();
  }

  _listen() {
    const on = this.ctx?.on;
    this._debug(`listen: ctx.on type=${typeof on}`);
    if (typeof on !== 'function') return;
    const disposers = [];
    const sessionDispose = on.call(this.ctx, 'session/event', (session, event) =>
      this._onSessionEvent(session, event),
    );
    if (typeof sessionDispose === 'function') disposers.push(sessionDispose);
    const approvalDispose = on.call(this.ctx, 'approval/request', (request, next) =>
      this._onApproval(request, next),
    );
    if (typeof approvalDispose === 'function') disposers.push(approvalDispose);
    this._disposers = disposers;
    this._debug(`listeners registered: ${disposers.length}`);
  }

  _debug(message) {
    try {
      fs.mkdirSync(path.dirname(this._debugFile), { recursive: true });
      fs.appendFileSync(this._debugFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* 调试日志失败不影响主流程 */
    }
  }

  /** realpath + workspaces 白名单；越界直接抛错。 */
  assertWorkspace(cwd) {
    const resolved = fs.realpathSync(path.resolve(String(cwd || '')));
    const allowed = this.config.workspaces.some((root) => {
      const base = fs.realpathSync(path.resolve(root));
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    });
    if (!allowed) {
      throw new SessionAdapterError(`cwd is outside the allowed workspaces: ${resolved}`);
    }
    return resolved;
  }

  /**
   * 创建（或恢复）一个 Worker Session，并绑定到 task_id。
   * 这里只建会话，不发第一轮 prompt；由 runtime 调 prompt()。
   */
  async open({ taskId, cwd }) {
    const controller = this.ctx?.sessionController;
    if (!controller?.create || !controller?.resolveAgent) {
      throw new SessionAdapterError('ctx.sessionController.create/resolveAgent is unavailable');
    }
    const resolvedCwd = this.assertWorkspace(cwd);
    const sessionId = `neobot-worker-${taskId}`;
    this._debug(`open task=${taskId} cwd=${resolvedCwd} session=${sessionId}`);

    // 已存在的任务：先尝试 resolve；resume 失败再新建。
    let agent = null;
    try {
      const existing = await controller.resolveAgent(sessionId);
      if (existing && 'agent' in existing && existing.agent) {
        agent = existing.agent;
      }
    } catch (error) {
      this.logger.warn?.(`[neobot-worker] resolve existing session failed: ${error?.message || error}`);
    }

    if (!agent) {
      await controller.create({
        sessionId,
        cwd: resolvedCwd,
        agentPreset: this.config.agentPreset,
      });
      const created = await controller.resolveAgent(sessionId);
      if (!created || 'error' in created) {
        throw new SessionAdapterError(
          `resolve created session failed: ${created?.error?.message || created?.error?.code || 'unknown'}`,
        );
      }
      agent = created.agent;
    }

    try {
      this.ctx.permissionPresets?.set(agent.session, this.config.permissionPreset);
    } catch (error) {
      this.logger.warn?.(`[neobot-worker] set permission preset failed: ${error?.message || error}`);
    }
    try {
      await controller.rename?.({ sessionId, title: `neobot ${taskId}` });
    } catch (error) {
      this.logger.debug?.(`[neobot-worker] rename session failed: ${error?.message || error}`);
    }

    const session = {
      taskId,
      sessionId,
      agent,
      running: false,
      lastAssistant: '',
      counter: 0,
      turnToken: 0,
      doneReported: false,
    };
    this._sessions.set(taskId, session);
    this._bySession.set(sessionId, taskId);
    this._byAgent.set(agent, taskId);
    return { sessionId };
  }

  /** 唤醒空闲会话开一轮（或排队下一轮）。 */
  async prompt(taskId, text) {
    const session = this._require(taskId);
    this._debug(`prompt task=${taskId} chars=${String(text).length}`);
    this._deliver(session, text, 'followup');
    session.running = true;
    session.lastAssistant = '';
    session.doneReported = false;
    const token = ++session.turnToken;
    void this._watchTurn(session, token);
  }

  /** 插话：下一步生效。 */
  async steer(taskId, text) {
    const session = this._require(taskId);
    this._deliver(session, text, 'steer');
    session.running = true;
    session.doneReported = false;
    const token = ++session.turnToken;
    void this._watchTurn(session, token);
  }

  /** 取消当前轮；未完成的审批一起取消。 */
  async cancel(taskId, reason = '') {
    const session = this._require(taskId);
    for (const [requestId, pending] of this._approvals) {
      if (pending.taskId !== taskId) continue;
      this._settleApproval(requestId, 'cancelled');
    }
    session.agent.cancel({ kind: 'user', reason: reason || undefined }, { keepInbox: false });
    session.running = false;
  }

  /** 回答一次审批（one-shot）。 */
  async answerPermission(taskId, requestId, allow) {
    void taskId;
    return this._settleApproval(requestId, allow ? 'allowed-once' : 'rejected');
  }

  async status(taskId) {
    const session = this._sessions.get(taskId);
    if (!session) return null;
    return {
      session_id: session.sessionId,
      running: session.running,
      status: session.agent?.status || 'unknown',
    };
  }

  /** 重连对账：返回当前仍持有 session 的任务。 */
  aliveTaskIds() {
    return [...this._sessions.keys()];
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const requestId of [...this._approvals.keys()]) {
      this._settleApproval(requestId, 'cancelled');
    }
    for (const dispose of this._disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 卸载时忽略 */
      }
    }
    this._sessions.clear();
    this._bySession.clear();
    this._byAgent.clear();
  }

  // ── 内部 ────────────────────────────────────────────────────

  _require(taskId) {
    const session = this._sessions.get(String(taskId));
    if (!session) throw new SessionAdapterError(`no local session for task ${taskId}`);
    return session;
  }

  _deliver(session, text, mode) {
    const id = `neobot-worker:${session.taskId}:${++session.counter}`;
    const message = {
      id,
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    };
    if (mode === 'steer') session.agent.steer(message);
    else session.agent.followup(message);
  }

  _onSessionEvent(session, event) {
    if (!session || !event?.type) return;
    const taskId = this._bySession.get(session.id);
    this._debug(
      `session/event type=${event.type} session=${session.id || ''} task=${taskId || ''}`,
    );
    if (!taskId) return;
    const local = this._sessions.get(taskId);
    if (!local) return;
    const data = event.data || {};

    if (event.type === 'turn/start') {
      local.running = true;
      local.lastAssistant = '';
      this.onEvent?.(taskId, { type: 'start', turn: data.turn });
      return;
    }
    if (event.type === 'assistant/message') {
      const text = extractText(data.message?.content);
      if (text) local.lastAssistant = text;
      if (text) this.onEvent?.(taskId, { type: 'assistant', text });
      return;
    }
    if (event.type === 'tool/result') {
      if (data.isError) {
        this.onEvent?.(taskId, {
          type: 'tool_error',
          text: extractText(data.message?.content) || String(data.error || ''),
        });
      }
      return;
    }
    if (event.type === 'turn/end') {
      local.running = false;
      if (local.doneReported) return;
      local.doneReported = true;
      this.onEvent?.(taskId, {
        type: 'done',
        reason: String(data.reason || ''),
        summary: local.lastAssistant || lastAssistantText(local.agent),
      });
    }
  }

  /**
   * 兜底：即使 session/event 监听没有回调，也用 whenIdle + session snapshot
   * 把「这一轮结束了」和最后一条 assistant 文本报回去。事件监听正常时
   * doneReported 会先置位，这里自动跳过。
   */
  async _watchTurn(session, token) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await session.agent.whenIdle?.();
    } catch (error) {
      this._debug(`whenIdle failed task=${session.taskId}: ${error?.message || error}`);
      return;
    }
    if (token !== session.turnToken || session.doneReported) return;
    session.doneReported = true;
    session.running = false;
    const summary = lastAssistantText(session.agent);
    this._debug(`whenIdle done task=${session.taskId} summary=${summary.slice(0, 80)}`);
    this.onEvent?.(session.taskId, { type: 'done', reason: 'end_turn', summary });
  }

  async _onApproval(request, next) {
    const taskId = this._byAgent.get(request?.agent);
    this._debug(`approval/request task=${taskId || ''} tool=${request?.toolName || ''}`);
    if (!taskId || typeof this.onPermission !== 'function') {
      // 找不到归属就 fail closed，绝不默认放行。
      return 'rejected';
    }
    const requestId = randomUUID();
    const timeoutSeconds = Number(this.config.approvalTimeoutSeconds) || 600;
    const outcome = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._settleApproval(requestId, 'rejected');
      }, timeoutSeconds * 1000);
      timer.unref?.();
      this._approvals.set(requestId, { resolve, timer, taskId });
    });
    this.onPermission(taskId, {
      request_id: requestId,
      action: String(request.toolName || 'unknown'),
      detail: String(request.reason || ''),
      timeout_seconds: timeoutSeconds,
    });
    try {
      return await outcome;
    } catch {
      return next ? next() : 'rejected';
    }
  }

  _settleApproval(requestId, outcome) {
    const pending = this._approvals.get(requestId);
    if (!pending) return false;
    this._approvals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
    return true;
  }
}

/** 从 Session snapshot 的最后一条 assistant/message 取文本。 */
function lastAssistantText(agent) {
  try {
    const session = agent?.session;
    const events = session?.snapshotEvents?.() || [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'assistant/message') continue;
      const text = extractText(event.data?.message?.content);
      if (text) return text;
    }
  } catch {
    /* 取不到就返回空串 */
  }
  return '';
}

/** 从 DSH ContentBlock[] 里拼出文本（忽略图片等非文本块）。 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}
