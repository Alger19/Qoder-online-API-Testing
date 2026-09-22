#!/bin/zsh
# ---------------------------------------------------------------------------
# 双击这个文件，把本机服务装成 macOS 的常驻后台服务（LaunchAgent）。
#
# 装完之后：
#   · 开机自动启动，不需要你手动跑 node
#   · 进程意外退出会自动拉起来
#   · 以后直接打开页面（或双击 start.command）就能用
#
# 想取消：双击 uninstall-service.command
# ---------------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1

LABEL="cn.qoder.localchat"
PROJECT_DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8787}"

# 找到 node 的绝对路径（LaunchAgent 的环境极简，必须写死绝对路径）
NODE_BIN=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node，无法安装。请先安装 Node.js。"
  echo
  echo "按回车键关闭…"
  read -r _
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"

echo "正在安装常驻服务…"
echo "  项目目录：$PROJECT_DIR"
echo "  node     ：$NODE_BIN"
echo "  端口     ：$PORT"
echo

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$PROJECT_DIR/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$PORT</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <!-- 登录后自动启动；退出后自动拉起来 -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- 万一启动就崩，别疯狂重启刷日志 -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/service.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/service.error.log</string>
</dict>
</plist>
PLIST_EOF

# 先卸掉旧的（如果装过）
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
sleep 0.5

# 关键：如果端口已经被某个手动起的 node 占着，LaunchAgent 会因端口冲突
# 反复启动失败（EADDRINUSE）。先把它让出来。
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "· 端口 $PORT 上已有一个服务在跑，先停掉它，交给常驻服务接管…"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 1.5
fi

# 装载（现代 macOS 用 bootstrap；老版本回退到 load）
BOOT_ERR="$(launchctl bootstrap "gui/$UID" "$PLIST" 2>&1)"
if [ $? -ne 0 ]; then
  echo "· bootstrap 没成功：$BOOT_ERR"
  echo "· 回退尝试 launchctl load…"
  launchctl unload -w "$PLIST" 2>/dev/null
  BOOT_ERR="$(launchctl load -w "$PLIST" 2>&1)"
  if [ $? -ne 0 ]; then
    echo "· load 也没成功：$BOOT_ERR"
  fi
fi

sleep 2

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 安装成功，服务已经在 http://127.0.0.1:$PORT/ 运行。"
  echo
  echo "  以后打开页面就能直接用，不用再手动跑 node。"
  echo "  查看日志：$PROJECT_DIR/logs/service.log"
  echo "  取消常驻：双击 uninstall-service.command"
else
  echo "✗ 配置文件已写好，但端口 $PORT 上还没听到服务。下面是排查线索："
  echo
  echo "── launchd 里的状态 ──"
  launchctl print "gui/$UID/$LABEL" 2>&1 | head -20
  echo
  echo "── 错误日志 ──"
  if [ -s "$PROJECT_DIR/logs/service.error.log" ]; then
    tail -20 "$PROJECT_DIR/logs/service.error.log"
  else
    echo "(空的 —— 说明进程根本没被启动过，问题多半在 launchd 装载这一步)"
  fi
  echo
  echo "── 替代方案 ──"
  echo "如果上面写着 Input/output error 之类，说明这台机器不允许它自动启动。"
  echo "那就用双击 start.command 的方式：服务会在那个终端窗口里跑，"
  echo "页面一样能连上，只是需要你手动开一次窗口。"
fi

echo
echo "按回车键关闭…"
read -r _
