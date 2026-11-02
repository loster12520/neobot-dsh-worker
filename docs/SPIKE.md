# SPIKE：接通 DSH 进程内 Session API

> 目标：在 0.2.1-rc.2 上确认 `src/session-adapter.js` 需要的 5 个调用，并写一个
> 本地单任务冒烟。**完成前不要宣称 daemon 可用**。

## 1. 创建 Session

参考官方原型 `dsh-superagent-prototype/src/app/sessions.ts`：

```ts
const created = await ctx.sessionController.create({
  // 需要确认的字段：cwd / agentPreset / workspaceId / sessionId
})
const agent = await ctx.sessionController.resolveAgent(created.sessionId)
```

验证点：

- `create` 的必填字段（cwd 是否直接传？还是先 `workspaceRegistry.create`？）
- 返回结构里 sessionId 的字段名
- preset 是按 id 选择，还是传 `agentPreset` 对象
- 失败时返回什么（错误码 / 抛异常）

## 2. 订阅事件

需要拿到：assistant 消息、工具调用、轮次结束、错误、权限请求。

验证点：

- `ctx.on('session/event', ...)` 还是 `sessionController` 上的订阅？
- 事件里是否有 `sessionId`、`turn/start`、`turn/end`、`assistant/message`、`tool/result`
- 如何判断「这一轮结束了」（发 `task.done` 的时机）

## 3. 插话与取消

```ts
await agent.steer(text)            // 下一步生效
await agent.followup('queue')      // 空闲时再跑
await agent.cancel({ kind: 'user' }) // 中止
```

验证点：

- 三个方法的准确签名与返回值
- 运行中调用 `steer` 是立即进入下一步，还是排队到下一步
- cancel 之后会话能否继续 `followup`

## 4. 权限请求

验证点：

- `approval.policy=ask` 时，进程内如何收到 permission request（事件？回调？）
- 能否回 `allow-once` / `reject-once`；超时如何 fail closed
- 如果拿不到，降级方案：`workspace-write` 硬拒 + 把失败作为 `task.event(blocker)` 上报

## 5. 重启恢复

验证点：

- daemon 重启后，用本地 `task_id -> sessionId` 映射能否 `resolveAgent` 恢复
- 恢复失败时新建 session 的代价（上下文丢失）与提示文案
- `daemon.hello` 对账时上报什么字段最有用

## 验收

```bash
# 开发机本地
dsh --profile neobot-worker web --host 127.0.0.1 --port 3083

# NeoBot 侧（手动/脚本）发一个 task.open，观察：
# 1. daemon 拉起 Worker Session
# 2. task.event(stage) 上报
# 3. 运行中发 task.input(steer) 生效
# 4. 轮次结束发 task.done
# 5. daemon kill 后重启，能恢复/明确失败
```
