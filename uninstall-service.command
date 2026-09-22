#!/bin/zsh
# ---------------------------------------------------------------------------
# 双击这个文件，卸载之前装上的常驻服务（LaunchAgent）。
# 卸载后服务会停止，开机也不再自动启动。
# ---------------------------------------------------------------------------
LABEL="cn.qoder.localchat"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8787}"

echo "正在卸载常驻服务…"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
launchctl unload -w "$PLIST" 2>/dev/null

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "✓ 已删除 $PLIST"
else
  echo "· 没有找到配置文件（可能本来就没装）。"
fi

# 兜底：万一还有残留进程占着端口
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "· 端口 $PORT 仍被占用，正在停止残留进程…"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 端口 $PORT 上还有进程，请手动检查：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
else
  echo "✓ 已卸载，端口 $PORT 已释放。"
fi

echo
echo "按回车键关闭…"
read -r _
