/**
 * neobot-dsh-worker 插件入口。
 *
 * 职责：在开发机的 DSH 进程里常驻，出站轮询 NeoBot 网关，把 task.* 命令翻译成
 * 本机 DSH Session 的 prompt / steer / cancel。它不是 Router，也不直接对用户说话。
 */

import path from 'node:path';

import { ConfigError, loadConfig } from './config.js';
import { WorkerHealth } from './health.js';
import { WorkerRuntime } from './runtime.js';
import { DshSessionAdapter } from './session-adapter.js';
import { SyncClient } from './sync.js';
import { TaskRegistry } from './tasks.js';

export const name = 'neobot-worker';
export const inject = ['sessionController', 'agents', 'agentPresets', 'workspaceRegistry'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? console;
  let config;
  try {
    config = loadConfig(rawConfig);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error?.message || error);
    logger.error?.(`[neobot-worker] 配置无效，插件不启动：${message}`);
    return;
  }

  const registry = new TaskRegistry({
    file: path.join(config.stateDir, 'tasks.json'),
    logger,
  });
  const sessions = new DshSessionAdapter({ ctx, config, logger });
  const client = new SyncClient({
    gatewayUrl: config.gatewayUrl,
    token: config.token,
    daemonId: config.daemonId,
    pollWaitSeconds: config.pollWaitSeconds,
    logger,
  });
  const health = new WorkerHealth({ config, registry, client, sessions });
  client.healthProvider = () => health.snapshot();

  const runtime = new WorkerRuntime({ client, registry, sessions, config, logger });
  client.onCommand((command) => runtime.handle(command));

  const reaper = setInterval(() => {
    try {
      runtime.reap();
    } catch (error) {
      logger.warn?.(`[neobot-worker] reap failed: ${error?.message || error}`);
    }
  }, 30_000);
  reaper.unref?.();

  ctx.effect(
    () => async () => {
      clearInterval(reaper);
      client.stop();
      runtime.dispose();
    },
  );

  logger.info?.(
    `[neobot-worker] daemon=${config.daemonId} gateway=${config.gatewayUrl} ` +
      `workspaces=${config.workspaces.length} maxWorkers=${config.maxWorkers}`,
  );
  client.enqueueReport('daemon.health', 'daemon', health.snapshot());
  void client.start();
}
