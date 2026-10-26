#!/bin/bash
# 打 zip 分发包：重签（去 linker-signed，修复下载后「已损坏」）+ zip
# dmg 的 Finder 窗口布局在不同 macOS 版本行为不一致，zip 解压即用、无窗口问题
# 用法：先 `cd desktop && npx tauri build`，再跑本脚本
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/src-tauri/target/release/bundle/macos/接口调试.app"
VERSION="${1:-1.0.0}"
OUT="$DIR/src-tauri/target/release/bundle/dmg/api-tool-${VERSION}-aarch64.zip"

[ -d "$APP" ] || { echo "先构建 .app：cd desktop && npx tauri build" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/接口调试.app"

# 重签：Tauri 默认 linker-signed 签名在下载（quarantine）后会被 Gatekeeper 判为「已损坏」
codesign --force --deep --sign - "$STAGE/接口调试.app" >/dev/null 2>&1

cd "$STAGE"
rm -f "$OUT"
zip -q -r "$OUT" "接口调试.app"
echo "✓ 生成 $OUT（$(du -h "$OUT" | awk '{print $1}')）"
