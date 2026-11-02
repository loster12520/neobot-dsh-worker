/** 插件配置：从 profile 的 cordis.patch.yml 传入，启动时一次性校验。 */

import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {string} value */
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * @typedef {object} WorkerConfig
 * @property {string} gatewayUrl
 * @property {string} token
 * @property {string} daemonId
 * @property {string} stateDir
 * @property {string[]} workspaces
 * @property {number} maxWorkers
 * @property {number} pollWaitSeconds
 * @property {number} taskStaleSeconds
 * @property {string} agentPreset
 */

/** @param {Record<string, unknown>} raw @returns {WorkerConfig} */
export function loadConfig(raw = {}) {
  const gatewayUrl = String(raw.gatewayUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(gatewayUrl)) {
    throw new ConfigError('gatewayUrl must be an http(s) URL (set it in the profile patch)');
  }
  const token = String(raw.token || '').trim();
  if (token.length < 16) {
    throw new ConfigError('token must be at least 16 characters (set it in the profile patch)');
  }
  const daemonId = String(raw.daemonId || os.hostname()).trim();
  if (!daemonId) throw new ConfigError('daemonId must not be empty');

  const stateDir = path.resolve(expandHome(String(raw.stateDir || '~/.dsh/state/neobot-worker')));
  const workspaces = (Array.isArray(raw.workspaces) ? raw.workspaces : [])
    .map((item) => path.resolve(expandHome(String(item || ''))))
    .filter(Boolean);
  if (workspaces.length === 0) {
    throw new ConfigError('workspaces must list at least one absolute directory');
  }

  const maxWorkers = clampInt(raw.maxWorkers, 1, 8, 2, 'maxWorkers');
  const pollWaitSeconds = clampInt(raw.pollWaitSeconds, 5, 60, 25, 'pollWaitSeconds');
  const taskStaleSeconds = clampInt(raw.taskStaleSeconds, 60, 86400, 900, 'taskStaleSeconds');

  return {
    gatewayUrl,
    token,
    daemonId,
    stateDir,
    workspaces,
    maxWorkers,
    pollWaitSeconds,
    taskStaleSeconds,
    agentPreset: String(raw.agentPreset || 'neobot-worker'),
  };
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback @param {string} name */
function clampInt(value, min, max, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return number;
}
