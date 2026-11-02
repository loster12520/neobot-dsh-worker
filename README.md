# neobot-dsh-worker

NeoBot（Router）× DSH（Worker）里的**开发机侧常驻 daemon**：一个 DSH bundle 插件，
只出站连接 NeoBot 的核心网关，把 `task.*` 命令翻译成本机 DSH Session 的执行。

```text
NeoBot Router（QQ 侧，负责对话/分派/汇总）
   ↕  POST /dsh/daemon/sync（出站长轮询，token + seq/ack）
neobot-dsh-worker（本仓库，开发机 DSH 进程内插件）
   ↕  sessionController / agent.steer / cancel
多个 Worker Session（每任务一个，独立 cwd，完整工具，不直接对用户说话）
```

> 状态：**协议客户端 + DSH 会话适配已接通**。`sync / tasks / runtime / session-adapter`
> 均已实现并有 `node:test` 覆盖；当前在真机联调（事件回传、审批、daemon 重启恢复按
> `docs/SPIKE.md` 的验收项跑）。协议见 [PROTOCOL.md](PROTOCOL.md)。

## 1. 安装（开发机）

前置：

| 项 | 要求 |
|---|---|
| DSH | `0.2.1-rc.2` 附近；`dsh --version` 可执行 |
| Node | `^22.19` 或 `>=24` |
| NeoBot | 已开启 `agent.dsh.gateway.enabled` 并配好 token |
| 网络 | 开发机只需**出站**能访问 NeoBot 网关；不需要公网入站 |

步骤：

```bash
# 1) 建 profile（从 web 模板复制一份，避免和日常 profile 抢端口/会话）
dsh --from-default-profile web --profile neobot-worker
#    首次会启动 web 界面，确认能起来后 Ctrl-C

# 2) 把本仓库装进 profile
dsh plugin --profile neobot-worker add /path/to/neobot-dsh-worker

# 3) 在 profile 的 cordis.patch.yml 追加连接配置（复制 examples/profile.cordis.patch.yml）
#    ~/.dsh/profiles/neobot-worker/cordis.patch.yml
#    gatewayUrl / token / daemonId / workspaces 必须填

# 4) 启动（不需要 UI 时端口可以随便给，或 --port 0）
dsh --profile neobot-worker web --host 127.0.0.1 --port 3083
```

启动日志应出现：

```text
[neobot-worker] daemon=devbox-a gateway=http://... workspaces=1 maxWorkers=2
```

## 2. 配置

profile patch 里 `neobot-worker` 条目的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `gatewayUrl` | 必填 | NeoBot 网关地址，如 `http://127.0.0.1:8791` |
| `token` | 必填 | 与 NeoBot `agent.dsh.gateway.token` 一致；≥16 字符 |
| `daemonId` | 主机名 | 同一 NeoBot 下唯一；重复会让事件串台 |
| `stateDir` | `~/.dsh/state/neobot-worker` | 任务登记与本地状态 |
| `workspaces` | 必填 | 允许执行任务的工作区根目录（绝对路径） |
| `maxWorkers` | `2` | 同时运行的 Worker Session 上限（1–8） |
| `pollWaitSeconds` | `25` | 长轮询挂起秒数（5–60） |
| `taskStaleSeconds` | `900` | 多久没事件标 stale |
| `agentPreset` | `neobot-worker` | Worker Session 使用的 DSH preset |

## 3. 本地自检

```bash
npm test          # node --test：协议同步、去重、401 致命错误
npm run check     # node --check 语法
```

不需要 DSH 进程；`session-adapter` 的单测用 fake `ctx`/`agent`，不依赖真实 DSH。

## 4. 目录

```text
src/
├── index.js            # 插件入口（cordis name/inject/apply）
├── config.js           # 配置校验
├── protocol.js         # 协议常量与校验
├── sync.js             # 出站长轮询（seq/ack/去重/退避）
├── tasks.js            # 任务登记（JSON 原子写）
├── runtime.js          # 命令 → 任务 + 会话
├── session-adapter.js  # 唯一依赖 DSH 内部 API 的适配层（创建/事件/审批）
└── health.js           # 容量/健康快照
docs/SPIKE.md           # 真机验收清单（会话/事件/插话/审批/重启恢复）
```

## 5. 边界

- 不直接对用户说话；所有对外回复由 NeoBot Router 负责。
- 不保存 NeoBot token 的明文日志；401 直接停循环，不无限重试。
- `cwd` 必须落在 `workspaces` 白名单内（realpath 校验）。
- 审批 one-shot、超时拒绝；群聊审批被发言策略拦截时由 NeoBot 侧 `/dsh pending` 兜底。
