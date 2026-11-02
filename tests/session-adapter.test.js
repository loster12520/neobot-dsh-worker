/** DSH 会话适配层：用 fake ctx/agent 验证 create/prompt/steer/cancel/事件/审批。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DshSessionAdapter } from '../src/session-adapter.js';
import { loadConfig } from '../src/config.js';

function makeHarness() {
  const handlers = {};
  const calls = [];
  let created = false;
  const agent = {
    id: 'agent-1',
    session: { id: 'neobot-worker-t-1' },
    status: 'idle',
    followup(message) {
      calls.push(['followup', message]);
    },
    steer(message) {
      calls.push(['steer', message]);
    },
    cancel(cause, options) {
      calls.push(['cancel', cause, options]);
    },
  };
  const ctx = {
    on(event, handler) {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    },
    sessionController: {
      async create(request) {
        calls.push(['create', request]);
        created = true;
        return { sessionId: request.sessionId, agentPreset: request.agentPreset };
      },
      async resolveAgent(sessionId) {
        if (!created || sessionId !== agent.session.id) {
          return { error: { code: 'session/not-found' } };
        }
        return { agent };
      },
      async rename(request) {
        calls.push(['rename', request]);
      },
    },
    permissionPresets: {
      set(session, preset) {
        calls.push(['permission', session, preset]);
      },
    },
  };
  const config = loadConfig({
    gatewayUrl: 'http://127.0.0.1:8791',
    token: 'test-token-1234567890',
    daemonId: 'devbox-test',
    workspaces: [process.cwd()],
    permissionPreset: 'workspace-write',
  });
  const adapter = new DshSessionAdapter({ ctx, config });
  const events = [];
  const permissions = [];
  adapter.onEvent = (taskId, event) => events.push([taskId, event]);
  adapter.onPermission = (taskId, request) => permissions.push([taskId, request]);
  return { adapter, agent, calls, handlers, events, permissions };
}

test('open 创建会话、设置权限档，prompt/steer/cancel 走 agent API', async () => {
  const { adapter, calls } = makeHarness();
  const opened = await adapter.open({ taskId: 't-1', cwd: process.cwd() });
  assert.equal(opened.sessionId, 'neobot-worker-t-1');
  assert.ok(calls.some(([name]) => name === 'create'));
  assert.ok(calls.some(([name]) => name === 'permission'));

  await adapter.prompt('t-1', '分析项目');
  await adapter.steer('t-1', '只看 README');
  await adapter.cancel('t-1', '用户取消');

  const followup = calls.find(([name]) => name === 'followup');
  assert.equal(followup[1].id, 'neobot-worker:t-1:1');
  assert.equal(followup[1].content[0].text, '分析项目');
  assert.ok(calls.some(([name]) => name === 'steer'));
  const cancel = calls.find(([name]) => name === 'cancel');
  assert.equal(cancel[1].kind, 'user');
});

test('session 事件回传 start/assistant/done', async () => {
  const { adapter, handlers, events } = makeHarness();
  await adapter.open({ taskId: 't-1', cwd: process.cwd() });

  handlers['session/event'](
    { id: 'neobot-worker-t-1' },
    { type: 'turn/start', data: { turn: 1 } },
  );
  handlers['session/event'](
    { id: 'neobot-worker-t-1' },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '项目结构不错' }] } },
    },
  );
  handlers['session/event'](
    { id: 'neobot-worker-t-1' },
    { type: 'turn/end', data: { reason: 'end_turn' } },
  );

  assert.deepEqual(events.map(([, event]) => event.type), ['start', 'assistant', 'done']);
  assert.equal(events[1][1].text, '项目结构不错');
  assert.equal(events[2][1].summary, '项目结构不错');
});

test('审批请求上报并等待 answerPermission 放行', async () => {
  const { adapter, handlers, permissions } = makeHarness();
  await adapter.open({ taskId: 't-1', cwd: process.cwd() });

  const approval = handlers['approval/request'];
  assert.equal(typeof approval, 'function');
  const outcomePromise = approval(
    { agent: adapter._sessions.get('t-1').agent, toolName: 'bash', reason: '需要执行命令' },
    async () => 'unavailable',
  );

  assert.equal(permissions.length, 1);
  const [, request] = permissions[0];
  assert.equal(request.action, 'bash');
  assert.equal(request.detail, '需要执行命令');

  assert.equal(await adapter.answerPermission('t-1', request.request_id, true), true);
  assert.equal(await outcomePromise, 'allowed-once');
});

test('workspace 白名单外直接拒绝', async () => {
  const { adapter } = makeHarness();
  await assert.rejects(
    () => adapter.open({ taskId: 't-2', cwd: '/etc' }),
    /outside the allowed workspaces/,
  );
});
