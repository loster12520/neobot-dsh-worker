/** 协议/客户端冒烟测试：node --test tests/ 直接跑，不需要 DSH 进程。 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { SyncAuthError, SyncClient } from '../src/sync.js';

function startServer(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      Promise.resolve(handler({ req, res, body: body ? JSON.parse(body) : null })).catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('syncOnce 上报事件、拉取命令并 ack', async () => {
  const requests = [];
  let calls = 0;
  const { server, url } = await startServer(({ req, res, body }) => {
    requests.push({ auth: req.headers.authorization, body });
    calls += 1;
    const commands =
      calls === 1
        ? [{ id: 'cmd-1', kind: 'task.dispatch', task_id: 't-1', payload: { cwd: '/tmp', prompt: 'hi' } }]
        : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ v: 1, cursor: 1, commands }));
  });

  const client = new SyncClient({
    gatewayUrl: url,
    token: 'test-token-1234567890',
    daemonId: 'devbox-test',
    pollWaitSeconds: 5,
    logger: { info() {}, warn() {}, error() {} },
  });
  const handled = [];
  client.onCommand(async (command) => {
    handled.push(command);
  });
  client.enqueueReport('task.event', 't-1', { kind: 'stage', text: 'started' });

  try {
    await client.syncOnce();
    assert.equal(handled.length, 1);
    assert.equal(handled[0].id, 'cmd-1');
    assert.equal(requests[0].auth, 'Bearer test-token-1234567890');
    assert.equal(requests[0].body.reports.length, 1);
    assert.equal(requests[0].body.reports[0].seq, 1);

    await client.syncOnce();
    assert.deepEqual(requests[1].body.acks, ['cmd-1']);
    assert.deepEqual(requests[1].body.reports, []);
  } finally {
    client.stop();
    await stopServer(server);
  }
});

test('重复命令不会重复执行，但仍会 ack', async () => {
  let calls = 0;
  const { server, url } = await startServer(({ res }) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        v: 1,
        cursor: 1,
        commands:
          calls <= 2
            ? [{ id: 'cmd-dup', kind: 'task.status', task_id: 't-1', payload: {} }]
            : [],
      }),
    );
  });

  const client = new SyncClient({
    gatewayUrl: url,
    token: 'test-token-1234567890',
    daemonId: 'devbox-test',
    pollWaitSeconds: 5,
    logger: { info() {}, warn() {}, error() {} },
  });
  let handled = 0;
  client.onCommand(async () => {
    handled += 1;
  });

  try {
    await client.syncOnce();
    await client.syncOnce();
    assert.equal(handled, 1, '第二条重复命令不应再执行');
  } finally {
    client.stop();
    await stopServer(server);
  }
});

test('401 作为致命错误抛出，不无限重试', async () => {
  const { server, url } = await startServer(({ res }) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('bad token');
  });
  const client = new SyncClient({
    gatewayUrl: url,
    token: 'wrong-token-1234567890',
    daemonId: 'devbox-test',
    pollWaitSeconds: 5,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await assert.rejects(() => client.syncOnce(), (error) => {
      assert.ok(error instanceof SyncAuthError);
      assert.equal(error.status, 401);
      assert.equal(error.fatal, true);
      return true;
    });
  } finally {
    client.stop();
    await stopServer(server);
  }
});
