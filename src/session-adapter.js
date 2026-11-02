/**
 * DSH 会话适配层：把协议命令翻译成进程内 Session/Agent 调用。
 *
 * 这里是整个插件唯一依赖 DSH 内部 API 的地方；DSH 升级只改本文件。
 * 具体签名以 0.2.1-rc.2 的官方原型（dsh-superagent-prototype/src/app/sessions.ts）
 * 为参考，落地前需要跑一次 SPIKE（见 docs/SPIKE.md）：
 *
 *   const created = await ctx.sessionController.create({ cwd, agentPreset })
 *   const agent = await ctx.sessionController.resolveAgent(created.sessionId)
 *   await agent.steer(text) / agent.followup('queue') / agent.cancel(...)
 *
 * 在 SPIKE 完成前，open() 会抛 UnsupportedDshApi，避免“看起来能跑、实际没接上”。
 */

import fs from 'node:fs';
import path from 'node:path';

export class UnsupportedDshApi extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedDshApi';
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
    this._sessions = new Map(); // task_id -> { sessionId, agent }
  }

  /** realpath + workspaces 白名单；越界直接抛错。 */
  assertWorkspace(cwd) {
    const resolved = fs.realpathSync(path.resolve(String(cwd || '')));
    const allowed = this.config.workspaces.some((root) => {
      const base = fs.realpathSync(path.resolve(root));
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    });
    if (!allowed) {
      throw new Error(`cwd is outside the allowed workspaces: ${resolved}`);
    }
    return resolved;
  }

  async open({ taskId, cwd, prompt }) {
    void prompt;
    this.assertWorkspace(cwd);
    const controller = this.ctx?.sessionController;
    if (!controller?.create) {
      throw new UnsupportedDshApi('ctx.sessionController.create is unavailable in this DSH build');
    }
    throw new UnsupportedDshApi(
      'DSH session adapter not implemented yet: run docs/SPIKE.md first, then wire ' +
        'sessionController.create/resolveAgent here',
    );
    // 参考实现（SPIKE 确认后启用）：
    // const created = await controller.create({ cwd, agentPreset: this.config.agentPreset });
    // const agent = await controller.resolveAgent(created.sessionId);
    // this._sessions.set(taskId, { sessionId: created.sessionId, agent });
    // return { sessionId: created.sessionId };
  }

  async prompt(taskId, text) {
    const session = this._require(taskId);
    await session.agent.followup?.(text) ?? session.agent.steer?.(text);
  }

  async steer(taskId, text) {
    const session = this._require(taskId);
    await session.agent.steer(text);
  }

  async cancel(taskId, reason = '') {
    const session = this._require(taskId);
    await session.agent.cancel({ kind: 'user', reason });
  }

  async answerPermission(taskId, requestId, allow) {
    const session = this._require(taskId);
    await session.agent.answerPermission?.(requestId, allow);
  }

  async status(taskId) {
    const session = this._sessions.get(taskId);
    return session ? { session_id: session.sessionId } : null;
  }

  /** 重连对账：返回当前仍持有 session 的任务。 */
  aliveTaskIds() {
    return [...this._sessions.keys()];
  }

  _require(taskId) {
    const session = this._sessions.get(String(taskId));
    if (!session) throw new Error(`no local session for task ${taskId}`);
    return session;
  }
}
