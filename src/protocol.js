/**
 * neobot-dsh-worker ⇄ NeoBot 协议 v1：常量、校验与类型定义。
 * 两端以 PROTOCOL.md 为准；这里只做最小运行时校验，不做业务判断。
 */

export const PROTOCOL_VERSION = 1;

export const COMMAND_TYPES = new Set([
  'daemon.hello',
  'task.open',
  'task.input',
  'task.cancel',
  'task.status',
  'perm.answer',
]);

export const REPORT_TYPES = new Set([
  'task.event',
  'task.done',
  'perm.request',
  'daemon.health',
]);

export class ProtocolError extends Error {
  constructor(message, code = 'invalid_payload') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/**
 * @typedef {object} SyncReport
 * @property {number} seq
 * @property {string} type
 * @property {string} task_id
 * @property {object} payload
 */

/**
 * @typedef {object} DaemonCommand
 * @property {string} id
 * @property {string} type
 * @property {string} task_id
 * @property {object} payload
 */

/**
 * @typedef {object} SyncResponse
 * @property {number} v
 * @property {number} cursor
 * @property {DaemonCommand[]} commands
 */

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {SyncReport} report @returns {SyncReport} */
export function normalizeReport(report) {
  if (!isPlainObject(report)) {
    throw new ProtocolError('report must be an object');
  }
  const seq = report.seq;
  if (!Number.isInteger(seq) || seq < 1) {
    throw new ProtocolError('report.seq must be a positive integer');
  }
  if (!REPORT_TYPES.has(report.type)) {
    throw new ProtocolError(`unknown report type: ${String(report.type)}`, 'unknown_type');
  }
  if (typeof report.task_id !== 'string' || !report.task_id) {
    throw new ProtocolError('report.task_id must be a non-empty string');
  }
  const payload = report.payload === undefined ? {} : report.payload;
  if (!isPlainObject(payload)) {
    throw new ProtocolError('report.payload must be an object');
  }
  return { seq, type: report.type, task_id: report.task_id, payload };
}

/** @param {DaemonCommand} command @returns {DaemonCommand} */
export function normalizeCommand(command) {
  if (!isPlainObject(command)) {
    throw new ProtocolError('command must be an object');
  }
  if (typeof command.id !== 'string' || !command.id) {
    throw new ProtocolError('command.id must be a non-empty string');
  }
  if (!COMMAND_TYPES.has(command.type)) {
    throw new ProtocolError(`unknown command type: ${String(command.type)}`, 'unknown_type');
  }
  if (typeof command.task_id !== 'string' || !command.task_id) {
    throw new ProtocolError('command.task_id must be a non-empty string');
  }
  const payload = command.payload === undefined ? {} : command.payload;
  if (!isPlainObject(payload)) {
    throw new ProtocolError('command.payload must be an object');
  }
  return { id: command.id, type: command.type, task_id: command.task_id, payload };
}

/** @param {unknown} value @returns {SyncResponse} */
export function assertSyncResponse(value) {
  if (!isPlainObject(value)) {
    throw new ProtocolError('sync response must be an object');
  }
  if (value.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(`unsupported protocol version: ${String(value.v)}`, 'version_mismatch');
  }
  if (!Number.isInteger(value.cursor) || value.cursor < 0) {
    throw new ProtocolError('sync response cursor must be a non-negative integer');
  }
  const commands = Array.isArray(value.commands) ? value.commands : [];
  return { v: PROTOCOL_VERSION, cursor: value.cursor, commands: commands.map(normalizeCommand) };
}
