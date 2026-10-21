# 接口调试（本地版 Postman）

单文件前端 + 本地反代（解决 CORS、状态持久化），Tauri 桌面壳 7MB。日常调试够用，不依赖云。

## 入口

| 用途 | 命令 |
|---|---|
| 浏览器版 | `node server.mjs` → http://127.0.0.1:8799 |
| 桌面版开发 | `cd desktop && npx tauri dev` |
| 桌面版构建 + 安装 | `cd desktop && npm run deploy` |

桌面版产物：`desktop/src-tauri/target/release/bundle/macos/接口调试.app`

## 数据

| 版本 | 位置 |
|---|---|
| 浏览器版 | `./data.json` |
| 桌面版 | `~/Library/Application Support/local.api-tool/data.json` |

- 首次启动用 `data.example.json` 播种（不含任何 token）
- 数据写入为原子操作（tmp + rename），崩溃不会写坏文件
- 集合可在侧栏导出/导入，兼容 Postman collection 格式

## 自检

```bash
node server.mjs --selftest   # 代理往返、头校验、超时取消、重定向、来源校验
```

## 结构

```
index.html          前端全部（HTML/CSS/JS 单文件）
server.mjs          浏览器版：静态页 + 反代 + 状态持久化
data.json           浏览器版数据（含 token，已 gitignore）
data.example.json   桌面版首次启动种子
desktop/            Tauri 壳（Rust: axum 同构 API + reqwest 代理 + 毛玻璃）
```

## 注意

- 本地 API 只接受 127.0.0.1 / localhost 的 Host 与 Origin
- 导出/重装前记得备份 `data.json`（里面有登录 token）
