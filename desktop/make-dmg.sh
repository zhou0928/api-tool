#!/bin/bash
# 打 dmg：重签（去 linker-signed，修复下载后「已损坏」）+ hdiutil 打包 + AppleScript 设置窗口大小
# 用法：先 `cd desktop && npx tauri build`，再跑本脚本
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/src-tauri/target/release/bundle/macos/接口调试.app"
VERSION="${1:-1.0.0}"
OUT="$DIR/src-tauri/target/release/bundle/dmg/api-tool-${VERSION}-aarch64.dmg"

[ -d "$APP" ] || { echo "先构建 .app：cd desktop && npx tauri build" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/接口调试.app"

# 1) 重新签名：Tauri 默认 linker-signed 签名在下载（quarantine）后会被 Gatekeeper 判为
#    「已损坏」且不提供「仍要打开」。普通 adhoc 签名没有这个问题。
codesign --force --deep --sign - "$STAGE/接口调试.app" >/dev/null 2>&1

ln -s /Applications "$STAGE/Applications"

# 2) AppleScript 设置 Finder 窗口大小（生成 .DS_Store 布局）；失败不阻塞打包
osascript <<EOF >/dev/null 2>&1 || true
tell application "Finder"
  set d to POSIX file "$STAGE" as alias
  open d
  delay 0.5
  tell window 1
    set current view to icon view
    set toolbar visible to false
    set statusbar visible to false
    set bounds to {100, 100, 620, 440}
  end tell
  delay 0.5
  close window 1
end tell
EOF

# 3) hdiutil 打包（UDZO 压缩）
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "接口调试" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "✓ 生成 $OUT（$(du -h "$OUT" | awk '{print $1}')）"
