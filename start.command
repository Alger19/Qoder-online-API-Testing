#!/bin/zsh
# ---------------------------------------------------------------------------
# 双击这个文件即可启动本机服务并打开页面（Finder 里双击，或终端里 ./start.command）
#
# 服务会运行在这个窗口里：关掉窗口（或按 Ctrl+C）服务就停止。
# 想让它开机自启、一直后台待命 —— 双击 install-service.command 装一次就行。
# ---------------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"

# 找到 node（双击启动时 PATH 可能不全，按常见位置兜底）
NODE_BIN="$(command -v node 2>/dev/null)"
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -z "$NODE_BIN" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node。请先安装 Node.js（https://nodejs.org）后重试。"
  echo
  echo "按回车键关闭…"
  read -r _
  exit 1
fi

# 已经在跑？那就不用再起一个，直接开页面。
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 本机服务已经在 http://127.0.0.1:$PORT/ 运行了，直接打开页面。"
  open "http://127.0.0.1:$PORT/"
  sleep 1
  exit 0
fi

echo "正在启动本机服务（端口 $PORT）…"
echo

"$NODE_BIN" server.js &
SERVER_PID=$!

# 窗口被关掉 / Ctrl+C 时，顺手把服务停掉，不留孤儿进程。
cleanup() {
  echo
  echo "正在停止服务…"
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# 等端口真的起来再开浏览器，避免页面抢跑报「连不上本地服务」。
for _ in {1..40}; do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT/"
  echo "────────────────────────────────────────────────────────────"
  echo "  页面已打开：http://127.0.0.1:$PORT/"
  echo "  首次使用请在页面上填入你的 PAT（pt- 开头）。"
  echo
  echo "  这个窗口需要保持打开；要停止服务就关掉它或按 Ctrl+C。"
  echo "────────────────────────────────────────────────────────────"
else
  echo "✗ 服务没能在 $PORT 端口启动，上面应该有报错信息。"
fi

wait "$SERVER_PID"
