// 接口调试桌面版：把 server.mjs 的 HTTP API 用 axum 原样搬进 Tauri 进程，
// 前端 index.html 编译期嵌入、零改动。数据落在应用数据目录，首次启动用项目内 data.json 播种。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::State,
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::Mutex};
use tokio_util::sync::CancellationToken;

const INDEX_HTML: &str = include_str!("../../../index.html");
const SEED_DATA: &str = include_str!("../../../data.example.json");
const SKIP: [&str; 7] = ["host", "content-length", "connection", "accept-encoding", "origin", "referer", "user-agent"];

struct AppState {
    cancels: Mutex<HashMap<String, CancellationToken>>,
    data_path: PathBuf,
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().build().expect("reqwest client"))
}

// 只允许本机访问：防浏览器里恶意网页把本机当内网跳板
fn local_authority(s: &str) -> bool {
    let a = s.split("://").last().unwrap_or(s);
    if a.starts_with("[::1]") {
        return true;
    }
    let host = a.split([':', '/', '?']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost")
}

async fn local_guard(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let host_ok = req.headers().get("host").and_then(|v| v.to_str().ok()).map(local_authority).unwrap_or(false);
    let origin_ok = req.headers().get("origin").and_then(|v| v.to_str().ok()).map(local_authority).unwrap_or(true);
    if host_ok && origin_ok {
        next.run(req).await
    } else {
        Json(json!({"error": "非法来源，仅允许本机访问"})).into_response()
    }
}

fn default_state() -> Value {
    json!({"env": {}, "envs": null, "envActive": "", "draft": null, "collections": [], "history": []})
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn state_get(State(st): State<Arc<AppState>>) -> Json<Value> {
    let mut v = default_state();
    if let Ok(s) = std::fs::read_to_string(&st.data_path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
            if let Some(obj) = parsed.as_object() {
                for (k, val) in obj {
                    v[k.as_str()] = val.clone();
                }
            }
        }
    }
    Json(v)
}

async fn state_post(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let mut next = default_state();
    for k in ["env", "envs", "envActive", "draft", "collections", "history"] {
        if let Some(val) = body.get(k) {
            next[k] = val.clone();
        }
    }
    if let Some(h) = next["history"].as_array_mut() {
        h.truncate(200);
    }
    next["savedAt"] = json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    );
    if let Ok(s) = serde_json::to_string_pretty(&next) {
        let tmp = st.data_path.with_extension("json.tmp");   // 原子写入，防写坏
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &st.data_path);
        }
    }
    Json(next)
}

async fn abort_req(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    if let Some(id) = body["id"].as_str() {
        if let Some(t) = st.cancels.lock().await.remove(id) {
            t.cancel();
        }
    }
    Json(json!({"ok": true}))
}

#[axum::debug_handler]
async fn api_send(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    Json(send_once(&st, &body).await)
}

async fn send_once(st: &AppState, body: &Value) -> Value {
    let t0 = Instant::now();
    let err = |e: String| json!({ "error": e });

    let url = match body["url"].as_str() {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => u,
        _ => return err("URL 必须是 http/https 绝对地址".into()),
    };
    let method = body["method"].as_str().unwrap_or("GET").to_uppercase();
    let m: reqwest::Method = match method.parse() {
        Ok(m) => m,
        Err(_) => return err(format!("不支持的 method：{method}")),
    };
    let secs = body["timeout"].as_f64().unwrap_or(30.0).clamp(0.05, 600.0);
    let id = body["id"].as_str().unwrap_or_default().to_string();

    let token = CancellationToken::new();
    if !id.is_empty() {
        st.cancels.lock().await.insert(id.clone(), token.clone());
    }

    let mut req = client().request(m, url).timeout(Duration::from_secs_f64(secs));
    let mut header_err: Option<String> = None;
    if let Some(hs) = body["headers"].as_object() {
        let mut hmap = reqwest::header::HeaderMap::new();
        for (k, v) in hs {
            if SKIP.contains(&k.to_lowercase().as_str()) {
                continue;
            }
            let val = v.as_str().unwrap_or_default();
            match (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(val),
            ) {
                (Ok(a), Ok(b)) => {
                    hmap.insert(a, b);
                }
                _ => {
                    header_err = Some(format!(
                        "请求头「{k}」含非法字符，HTTP 头名称只能是 ASCII，值只能是 Latin-1"
                    ));
                    break;
                }
            }
        }
        req = req.headers(hmap);
    }
    if let Some(e) = header_err {
        if !id.is_empty() {
            st.cancels.lock().await.remove(&id);
        }
        return err(e);
    }
    if !["GET", "HEAD"].contains(&method.as_str()) {
        let b = body["body"].as_str().unwrap_or_default();
        if !b.is_empty() {
            req = req.body(b.to_string());
        }
    }

    let res = tokio::select! {
        _ = token.cancelled() => {
            if !id.is_empty() {
                st.cancels.lock().await.remove(&id);
            }
            return err("已取消".into());
        }
        r = req.send() => match r {
            Ok(r) => r,
            Err(e) => {
                if !id.is_empty() {
                    st.cancels.lock().await.remove(&id);
                }
                return err(if e.is_timeout() {
                    format!("请求超过 {:.0}s 没有响应，已中断。可在发送按钮左侧调整超时秒数", secs)
                } else if e.is_connect() {
                    format!("连不上目标：{e}（检查地址/端口/网络）")
                } else {
                    e.to_string()
                });
            }
        },
    };
    if !id.is_empty() {
        st.cancels.lock().await.remove(&id);
    }

    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let final_url = res.url().to_string();
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut headers = serde_json::Map::new();
    for (k, v) in res.headers() {
        headers.insert(k.to_string(), json!(v.to_str().unwrap_or("")));
    }
    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(e) => return err(e.to_string()),
    };
    let low = ct.to_lowercase();
    let is_text = ["text", "json", "xml", "javascript", "html", "csv"]
        .iter()
        .any(|s| low.contains(s));
    let body_s = if is_text {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        format!("[二进制 {} 字节，content-type: {ct}]", bytes.len())
    };
    json!({
        "status": status,
        "statusText": status_text,
        "headers": headers,
        "body": body_s,
        "size": bytes.len(),
        "ms": t0.elapsed().as_millis() as u64,
        "finalUrl": final_url,
    })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;

            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            // 开发模式直接用项目里的 data.json（和 node 版共享数据）；打包版用应用数据目录
            let mut data_path = app_data.join("data.json");
            if cfg!(debug_assertions) {
                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data.json");
                if dev.exists() {
                    data_path = dev;
                }
            }
            if !data_path.exists() {
                std::fs::write(&data_path, SEED_DATA)?;
            }
            let state = Arc::new(AppState {
                cancels: Mutex::new(HashMap::new()),
                data_path,
            });

            // 8799 被占（比如 node 版在跑）就退到随机端口，两者可并存
            let listener = match tauri::async_runtime::block_on(TcpListener::bind("127.0.0.1:8799")) {
                Ok(l) => l,
                Err(_) => tauri::async_runtime::block_on(TcpListener::bind("127.0.0.1:0"))
                    .map_err(|e| e.to_string())?,
            };
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();

            let router = Router::new()
                .route("/", get(index))
                .route("/api/send", post(api_send))
                .route("/api/abort", post(abort_req))
                .route("/api/state", get(state_get).post(state_post))
                .with_state(state)
                .layer(middleware::from_fn(local_guard));
            tauri::async_runtime::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });

            let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}")).expect("本地地址解析失败");
            let win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("接口调试")
                .inner_size(1200.0, 760.0)
                .min_inner_size(960.0, 600.0)
                .transparent(true)
                .build()?;

            // macOS 毛玻璃：让窗口底色透出系统模糊，CSS 那边用半透明面板配合
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::UnderWindowBackground, None, Some(11.0));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
