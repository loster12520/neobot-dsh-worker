/** 出站长轮询客户端：把本地事件推给 NeoBot，把 NeoBot 的命令拉回来。 */

import { PROTOCOL_VERSION, assertSyncResponse } from './protocol.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

export class SyncAuthError extends SyncError {
  constructor(message, status) {
    super(message, status);
    this.name = 'SyncAuthError';
    this.fatal = true;
  }
}

export class SyncClient {
  /**
   * @param {object} options
   * @param {string} options.gatewayUrl
   * @param {string} options.token
   * @param {string} options.daemonId
   * @param {number} options.pollWaitSeconds
   * @param {object} [options.logger]
   * @param {Function} [options.fetchImpl]
   * @param {() => object} [options.healthProvider]
   */
  constructor({
    gatewayUrl,
    token,
    daemonId,
    pollWaitSeconds = 25,
    logger = console,
    fetchImpl = globalThis.fetch,
    healthProvider = null,
    maxBackoffMs = 30000,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new SyncError('global fetch is unavailable; Node.js 22+ is required');
    }
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    this.daemonId = daemonId;
    this.pollWaitSeconds = pollWaitSeconds;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.healthProvider = healthProvider;
    this.maxBackoffMs = maxBackoffMs;

    this.seq = 0;
    this.cursor = 0;
    this.failures = 0;
    this.fatalError = null;

    this._reports = [];
    this._acks = [];
    this._seenCommands = new Set();
    this._seenOrder = [];
    this._commandHandler = null;
    this._stopped = false;
    this._abort = null;
  }

  /** 注册命令处理器；返回 Promise 表示处理完成，失败时不 ack，下一轮重发。 */
  onCommand(handler) {
    this._commandHandler = handler;
  }

  /** 追加一条待上报事件；seq 单调递增。 */
  enqueueReport(type, taskId, payload = {}) {
    this.seq += 1;
    this._reports.push({ seq: this.seq, type, task_id: taskId, payload });
  }

  /** 单轮同步：上报本地事件 + 拉取并处理命令。 */
  async syncOnce() {
    const sentReports = this._reports.slice();
    const sentAcks = this._acks.slice();
    const payload = {
      v: PROTOCOL_VERSION,
      daemon_id: this.daemonId,
      seq: this.seq,
      cursor: this.cursor,
      health: this.healthProvider ? this.healthProvider() : undefined,
      reports: sentReports,
      acks: sentAcks,
    };

    const controller = new AbortController();
    this._abort = controller;
    const timeoutMs = (this.pollWaitSeconds + 15) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl}/dsh/daemon/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      this._abort = null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new SyncAuthError(`gateway rejected the daemon token (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new SyncError(`sync failed: HTTP ${response.status} ${detail}`.trim(), response.status);
    }

    const data = assertSyncResponse(await response.json());
    // 只有服务端确认收到后才清本地队列：断线时下一轮重发，服务端按 seq 去重。
    const sentReportSet = new Set(sentReports);
    const sentAckSet = new Set(sentAcks);
    this._reports = this._reports.filter((item) => !sentReportSet.has(item));
    this._acks = this._acks.filter((item) => !sentAckSet.has(item));
    this.cursor = data.cursor;

    for (const command of data.commands) {
      await this._deliver(command);
      this._rememberCommand(command.id);
      this._acks.push(command.id);
    }
    return data;
  }

  /** 常驻循环：成功立即下一轮（长轮询本身会等待），失败指数退避。 */
  async run() {
    this._stopped = false;
    while (!this._stopped) {
      try {
        await this.syncOnce();
        this.failures = 0;
        if (this._stopped) break;
        await sleep(50);
      } catch (error) {
        if (error?.fatal) {
          this.fatalError = error;
          this.logger.error?.(`[neobot-worker] ${error.message}`);
          break;
        }
        if (this._stopped) break;
        this.failures += 1;
        const delay = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(this.failures - 1, 5));
        this.logger.warn?.(
          `[neobot-worker] sync failed (${error?.message || error}); retry in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  /** 启动后台循环（不阻塞调用方）。 */
  start() {
    this._stopped = false;
    return this.run();
  }

  /** 停止循环并中断当前长轮询。 */
  stop() {
    this._stopped = true;
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
  }

  status() {
    return {
      version: '0.1.0',
      daemon_id: this.daemonId,
      seq: this.seq,
      cursor: this.cursor,
      failures: this.failures,
      fatal: this.fatalError?.message || null,
      pending_reports: this._reports.length,
      pending_acks: this._acks.length,
    };
  }

  async _deliver(command) {
    if (this._seenCommands.has(command.id)) {
      this.logger.info?.(`[neobot-worker] duplicate command ignored: ${command.id} (${command.type})`);
      return;
    }
    if (!this._commandHandler) {
      throw new SyncError(`no command handler for ${command.type}`);
    }
    await this._commandHandler(command);
  }

  _rememberCommand(id) {
    this._seenCommands.add(id);
    this._seenOrder.push(id);
    while (this._seenOrder.length > 512) {
      const oldest = this._seenOrder.shift();
      this._seenCommands.delete(oldest);
    }
  }
}

/** @param {Response} response */
async function safeText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}
