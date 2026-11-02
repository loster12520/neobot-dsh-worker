#!/usr/bin/env bash
# 复制 web profile 为 neobot-worker，并提示下一步。
# 用法：scripts/provision-profile.sh
# 幂等：目标 profile 已存在时不覆盖，只打印检查结果。
set -euo pipefail

PROFILE="${DSH_WORKER_PROFILE:-neobot-worker}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME/profiles/$PROFILE"

if [ -d "$TARGET" ]; then
  echo "profile 已存在：$TARGET（不覆盖）"
else
  echo "创建 profile：$TARGET"
  # --from-default-profile 会先复制模板再启动；首次启动后 Ctrl-C 即可。
  dsh --from-default-profile web --profile "$PROFILE" || true
fi

cat <<EOF

下一步：
1) 安装本仓库：
   dsh plugin --profile $PROFILE add $(cd "$(dirname "$0")/.." && pwd)
2) 把 examples/profile.cordis.patch.yml 的配置合并到：
   $TARGET/cordis.patch.yml
   至少填 gatewayUrl / token / daemonId / workspaces
3) 启动：
   dsh --profile $PROFILE web --host 127.0.0.1 --port 3083
EOF
