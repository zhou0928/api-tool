#!/bin/bash
# 手动打 dmg：绕开 tauri 内置 bundle_dmg.sh 依赖 Finder 自动化（无人值守时失败）的问题
# 用法：先 `cd desktop && npx tauri build`，再跑本脚本
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/src-tauri/target/release/bundle/macos/接口调试.app"
VERSION="${1:-1.0.0}"
OUT="$DIR/src-tauri/target/release/bundle/dmg/接口调试_${VERSION}_aarch64.dmg"

[ -d "$APP" ] || { echo "先构建 .app：cd desktop && npx tauri build" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# 临时目录：.app + Applications 拖拽快捷方式 → hdiutil 打包
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "接口调试" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT" >/dev/null
echo "✓ 生成 $OUT（$(du -h "$OUT" | awk '{print $1}')）"
