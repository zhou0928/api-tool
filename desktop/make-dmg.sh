#!/bin/bash
# 打 dmg：重签（去 linker-signed，修复下载后「已损坏」）+ hdiutil 打包 + ds-store 预设窗口布局
# 用法：先 `cd desktop && npx tauri build`，再跑本脚本
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/src-tauri/target/release/bundle/macos/接口调试.app"
VERSION="${1:-1.0.0}"
OUT="$DIR/src-tauri/target/release/bundle/dmg/api-tool-${VERSION}-aarch64.dmg"
VENV="$DIR/ds-venv"

[ -d "$APP" ] || { echo "先构建 .app：cd desktop && npx tauri build" >&2; exit 1; }

# ds-store 依赖（自动建 venv，首次运行装一次）
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q ds-store
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/接口调试.app"

# 1) 重新签名：Tauri 默认 linker-signed 签名在下载（quarantine）后会被 Gatekeeper 判为
#    「已损坏」且不提供「仍要打开」。普通 adhoc 签名没有这个问题。
codesign --force --deep --sign - "$STAGE/接口调试.app" >/dev/null 2>&1

ln -s /Applications "$STAGE/Applications"

# 2) ds-store 预设 Finder 窗口布局（620x420、图标位置）→ 生成 .DS_Store
"$VENV/bin/python" - "$STAGE" <<'EOF'
import ds_store, sys
stage = sys.argv[1]
ds = ds_store.DSStore.open(f'{stage}/.DS_Store', 'w+')
# 注意：Finder 的 bwsp 键是 windowWidth/windowHeight（小写 w），写错 Finder 不认
ds['.']['bwsp'] = {
    'windowWidth': 620.0, 'windowHeight': 420.0,
    'iconSize': 96.0, 'showToolbar': False, 'showStatusBar': False,
    'arrangement': 2,
}
ds['接口调试.app']['Iloc'] = (160, 180)
ds['Applications']['Iloc'] = (440, 180)
ds.close()
EOF

# 3) hdiutil 打包（UDZO 压缩）
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "接口调试" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "✓ 生成 $OUT（$(du -h "$OUT" | awk '{print $1}')）"
