/** 运行时事件回调：确认 turn/end 会更新状态并上报 task.done。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';

test('session done 事件更新任务并上报 task.done', () => {
  const reports = [];
  const updates = [];
  const record = { task_id: 't-1', status: 'running' };
  const registry = {
    get: () => record,
    update: (taskId, patch) => Object.assign(record, patch),
    list: () => [record],
    touch: () => record,
  };
  const client = {
    enqueueReport: (kind, taskId, payload) => reports.push({ kind, taskId, payload }),
    status: () => ({}),
  };
  const sessions = { aliveTaskIds: () => ['t-1'], dispose: () => {} };
  const runtime = new WorkerRuntime({
    client,
    registry,
    sessions,
    config: loadConfig({
      gatewayUrl: 'http://127.0.0.1:8791',
      token: 'test-token-1234567890',
      daemonId: 'devbox-test',
      workspaces: [process.cwd()],
    }),
    logger: { info() {}, warn() {}, error() {} },
  });

  runtime._onSessionEvent('t-1', { type: 'done', reason: 'end_turn', summary: '完成' });

  assert.equal(record.status, 'done');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'task.done');
  assert.equal(reports[0].payload.summary, '完成');
  updates.push(record.status);
});
