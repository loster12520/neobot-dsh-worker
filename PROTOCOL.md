# neobot-dsh-worker ⇄ NeoBot 协议（v1）

> 状态：草案 v1。两端以本文件为准；改动必须同时更新 `src/protocol.js` 与 NeoBot
> 仓库的 `docs/04-功能文档/dsh-router.md`。

## 1. 角色与传输

- **NeoBot**：核心最小网关（`app/src/neobot_app/dsh_gateway/`），只做 token 鉴权、
  长轮询、报告转交；不解析 DSH 语义。
- **daemon（本插件）**：运行在开发机，**只出站**连接 NeoBot，不监听端口。
- 传输：`POST {gatewayUrl}/dsh/daemon/sync`，JSON；`Authorization: Bearer <token>`。
- 长轮询：没有待下发命令时，服务端最多挂起 `poll_wait_seconds` 秒再返回空命令。

## 2. 同步请求

```json
{
  "v": 1,
  "daemon_id": "devbox-a",
  "seq": 42,
  "cursor": 41,
  "health": {"version": "0.1.0", "capacity": 2, "running": 1},
  "reports": [
    {"seq": 41, "type": "task.event", "task_id": "t-1", "payload": {"kind": "stage", "text": "改了 3 个文件"}},
    {"seq": 42, "type": "task.done", "task_id": "t-1", "payload": {"outcome": "completed", "summary": "测试通过"}}
  ],
  "acks": ["cmd-7"]
}
```

- `seq`：本 daemon 的事件序号，单调递增；`reports` 按 seq 升序。
- `cursor`：客户端已收到的最后一条命令的序号（服务端只用于诊断）。
- `acks`：上一轮已处理完成的命令 id；未 ack 的命令服务端会重发。
- `health`：可选；每轮上报，供 NeoBot 判断 daemon 能力与负载。

## 3. 同步响应

```json
{
  "v": 1,
  "server_time": 1762000000.0,
  "cursor": 7,
  "commands": [
    {"id": "cmd-7", "type": "task.open", "task_id": "t-1", "payload": {"cwd": "/repo", "mode": "write", "prompt": "..."}}
  ]
}
```

- `cursor`：服务端命令游标，客户端原样带回。
- `commands`：本轮新命令；客户端按顺序处理，成功后把 id 放进下一轮 `acks`。
- 命令可重复投递：`id` 是幂等键，处理方必须去重。

## 4. 命令（NeoBot → daemon）

| type | payload | 说明 |
|---|---|---|
| `daemon.hello` | `{}` | 连接/重连后的对账：daemon 返回当前任务清单与健康 |
| `task.open` | `{cwd, mode, prompt, policy?}` | 新建 Worker 会话并开始第一轮 |
| `task.input` | `{text, mode: "steer"\|"queue"}` | 插话：`steer` 下一步生效，`queue` 空闲时再跑 |
| `task.cancel` | `{reason?}` | 取消当前轮；会话保留 |
| `task.status` | `{}` | 请求回一条状态快照 |
| `perm.answer` | `{request_id, allow: bool}` | 回答越界审批 |

## 5. 报告（daemon → NeoBot）

| type | payload | 说明 |
|---|---|---|
| `task.event` | `{kind, text, data?}` | 语义事件：`kind ∈ stage / blocker / progress / artifact` |
| `task.done` | `{outcome: "completed"\|"failed"\|"cancelled", summary, artifacts?}` | 任务闭环 |
| `perm.request` | `{request_id, action, detail, timeout_seconds}` | 越界审批请求 |
| `daemon.health` | `{version, capacity, running, error?}` | 健康与容量 |

事件只传语义摘要，不传原始工具流；完整日志留在开发机本地，必要时以路径引用。

## 6. 任务状态机

```text
queued → starting → running → (waiting_permission) → done | failed | cancelled
```

- `stale`：NeoBot 超过 `task_stale_seconds` 未收到事件时标记（由插件侧计算，
  不是 daemon 上报的状态）。
- daemon 重启后：`daemon.hello` 上报仍在的 session；NeoBot 侧对账，未知任务标 stale，
  可恢复任务发 `task.input` 续跑。

## 7. 错误码（HTTP）

| 状态 | 含义 |
|---|---|
| 400 | 请求体非法（v/字段类型/seq 倒退） |
| 401 | 缺 token 或 token 不匹配 |
| 403 | 来源 IP 不在 `allow_ips` 内 |
| 413 | 请求体超过 `max_body_bytes` |
| 429 | 单 daemon 同步过于频繁（服务端限流，可选） |

## 8. 安全

- 默认只绑 `127.0.0.1`；跨机必须经反向代理 + HTTPS，token 不入日志。
- token 至少 32 字节随机值，支持轮换；401 时 daemon 退避，不刷屏。
- daemon 侧对 `cwd` 做 realpath + workspaces 白名单校验；越界直接拒绝。
- 审批 one-shot，超时 fail closed；群聊审批被发言策略拦截时由 NeoBot 侧
  `/dsh pending` 兜底。
