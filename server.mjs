#!/usr/bin/env node
// 本地接口调试工具：静态页 + 反向代理（解决 CORS）+ 状态持久化。零依赖。
import { createServer } from 'node:http'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const DATA = join(DIR, process.argv.includes('--selftest') ? 'data.selftest.json' : 'data.json')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'origin', 'referer', 'user-agent'])

const json = (res, code, obj) => {
  const b = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) })
  res.end(b)
}

const readBody = (req, limit = 20 * 1024 * 1024) => new Promise((ok, fail) => {
  const chunks = []
  let n = 0
  req.on('data', (d) => {
    n += d.length
    if (n > limit) { fail(new Error('body 超过 20MB')); req.destroy(); return }
    chunks.push(d)
  })
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
  req.on('error', fail)
})

// HTTP 头只能是 Latin-1；这里提前校验，避免 undici 抛出天书错误
function checkHeader(name, value) {
  for (const [i, ch] of [...String(name)].entries()) {
    if (ch.codePointAt(0) > 127) throw new Error(`请求头名称「${name}」第 ${i + 1} 个字符是「${ch}」，HTTP 头名称只能是 ASCII，请检查是否误粘了中文或省略号`)
  }
  for (const [i, ch] of [...String(value)].entries()) {
    const cp = ch.codePointAt(0)
    if (cp > 255) throw new Error(`请求头「${name}」的值第 ${i + 1} 个字符是「${ch}」（U+${cp.toString(16).toUpperCase()}），HTTP 头只能是 Latin-1。多半是粘贴时带进了省略号「…」或中文，删掉即可`)
  }
}

const emptyState = () => ({ env: {}, envs: null, envActive: '', collections: [], history: [] })

async function readState() {
  try { return { ...emptyState(), ...JSON.parse(await readFile(DATA, 'utf8')) } }
  catch { return emptyState() }
}

async function writeState(s) {
  const next = { env: s.env ?? {}, envs: s.envs ?? null, envActive: s.envActive ?? '', draft: s.draft ?? null, collections: s.collections ?? [], history: (s.history ?? []).slice(0, 200), savedAt: Date.now() }
  const tmp = DATA + '.tmp'   // 原子写入：防崩溃/断电写坏 data.json
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, DATA)
  return next
}

const inflight = new Map()   // id → AbortController，供前端「停止」按钮取消
const batches = new Map()    // 批量任务 id → AbortController，一次中断整批

async function send({ method = 'GET', url, headers = {}, body, timeout, id, extSignal }) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('URL 必须是 http/https 绝对地址')
  const m = method.toUpperCase()
  const h = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!k || v === undefined || v === null || v === '') continue
    if (SKIP_HEADERS.has(k.toLowerCase())) continue
    checkHeader(k, v)
    h[k] = String(v)
  }
  const t = Math.max(0.05, Number(timeout) || 30) * 1000   // 秒→毫秒；下限 50ms 是给自检用的
  const ac = new AbortController()
  if (id) inflight.set(String(id), ac)
  const t0 = Date.now()
  let res
  try {
    const sig = extSignal ? AbortSignal.any([ac.signal, extSignal, AbortSignal.timeout(t)]) : AbortSignal.any([ac.signal, AbortSignal.timeout(t)])
    res = await fetch(url, { method: m, headers: h, body: ['GET', 'HEAD'].includes(m) ? undefined : (body || undefined), redirect: 'follow', signal: sig })
  } catch (e) {
    if (ac.signal.aborted || extSignal?.aborted) throw new Error('已取消')
    if (e.name === 'TimeoutError') throw new Error(`请求超过 ${t / 1000}s 没有响应，已中断。可在发送按钮左侧调整超时秒数`)
    throw new Error(`连不上目标：${e.cause?.code || e.message}（检查地址/端口/网络）`)
  } finally {
    if (id) inflight.delete(String(id))
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const rh = {}
  for (const [k, v] of res.headers) rh[k] = v
  const isText = /text|json|xml|javascript|html|csv/i.test(res.headers.get('content-type') || '')
  return { status: res.status, statusText: res.statusText, headers: rh, body: isText ? buf.toString('utf8') : `[二进制 ${buf.length} 字节，content-type: ${res.headers.get('content-type')}]`, size: buf.length, ms: Date.now() - t0, finalUrl: res.url }
}

// 批量发送：在服务端扇出，绕开浏览器「同源最多 6 个并发连接」的限制
async function sendBatch({ times = 1, concurrency = 1, id = '', ...opts }) {
  const n = Math.max(1, Math.min(1000, Number(times) || 1))
  const c = Math.max(1, Math.min(200, Number(concurrency) || 1))
  const ac = new AbortController()
  if (id) batches.set(String(id), ac)
  const results = []
  let next = 0
  const t0 = Date.now()
  const worker = async () => {
    while (next < n) {
      const i = next++
      if (ac.signal.aborted) return
      try {
        const r = await send({ ...opts, id: `${id}:${i}`, extSignal: ac.signal })
        results.push({ ok: true, ms: r.ms, resp: r })
      } catch (e) {
        results.push({ ok: false, error: String(e?.message || e) })
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(c, n) }, worker))
  } finally {
    if (id) batches.delete(String(id))
  }
  const ok = results.filter((r) => r.ok)
  const fail = results.filter((r) => !r.ok)
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b)
  const pct = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : 0)
  return {
    aborted: ac.signal.aborted,
    times: n, concurrency: c, wall: Date.now() - t0,
    ok: ok.length, fail: fail.length,
    avg: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    min: ms[0] || 0, p95: pct(0.95), max: ms.at(-1) || 0,
    errors: [...new Set(fail.map((f) => f.error))].slice(0, 3),
    last: ok.at(-1)?.resp || null,
  }
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1')

    if (u.pathname.startsWith('/api/')) {
      // 只允许本机访问：防浏览器里恶意网页把你的机器当内网跳板
      const local = (s) => /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(s))
      const origin = req.headers.origin
      if (!local(req.headers.host) || (origin && !local(origin))) {
        return json(res, 403, { error: '非法来源，仅允许本机访问' })
      }
    }

    if (u.pathname === '/api/abort' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}')
      inflight.get(String(id))?.abort()
      batches.get(String(id))?.abort()
      return json(res, 200, { ok: true })
    }
    if (u.pathname === '/api/slow') { await new Promise((r) => setTimeout(r, 400)); return json(res, 200, { ok: 1 }) }   // 自检用慢路由
    if (u.pathname === '/api/r302') { res.writeHead(302, { location: '/api/ping' }); return res.end() }   // 自检用重定向路由
    if (u.pathname === '/api/batch' && req.method === 'POST') {
      try { return json(res, 200, await sendBatch(JSON.parse((await readBody(req)) || '{}'))) }
      catch (e) { return json(res, 200, { error: String(e?.message || e) }) }
    }
    if (u.pathname === '/api/send' && req.method === 'POST') {
      try { return json(res, 200, await send(JSON.parse((await readBody(req)) || '{}'))) }
      catch (e) { return json(res, 200, { error: String(e?.message || e) }) }
    }
    if (u.pathname === '/api/state') {
      if (req.method === 'GET') return json(res, 200, await readState())
      if (req.method === 'POST') return json(res, 200, await writeState(JSON.parse((await readBody(req)) || '{}')))
    }
    if (u.pathname === '/api/ping') return json(res, 200, { pong: Date.now() })

    const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname)
    const file = join(DIR, rel)
    if (!file.startsWith(DIR)) return json(res, 403, { error: 'forbidden' })
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) })
  }
})

// ponytail: 自检覆盖代理往返 + 头校验 + 状态存取；改逻辑后跑 `node server.mjs --selftest`
if (process.argv.includes('--selftest')) {
  const assert = (await import('node:assert/strict')).default
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (p, b) => fetch(base + p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json())

  assert.ok((await call('/api/ping')).pong)
  await call('/api/state', { env: { a: '1' }, collections: [{ id: 'g', name: 'G', requests: [] }] })
  assert.equal((await call('/api/state')).collections[0].name, 'G')

  const okRes = await call('/api/send', { url: `${base}/api/ping`, headers: { 'x-ok': 'yes' } })
  assert.equal(okRes.status, 200)
  assert.ok(JSON.parse(okRes.body).pong)

  const badHead = await call('/api/send', { url: `${base}/api/ping`, headers: { 'x-bad': 'abc…' } })
  assert.match(badHead.error, /Latin-1/)
  assert.equal((await call('/api/send', { url: 'ftp://x' })).error.includes('http'), true)

  const slow = await call('/api/send', { url: `${base}/api/slow`, timeout: 0.05 })
  assert.match(slow.error, /超过/)
  const abortP = call('/api/send', { url: `${base}/api/slow`, id: 'abc' })
  await new Promise((r) => setTimeout(r, 80))
  await call('/api/abort', { id: 'abc' })
  assert.match((await abortP).error, /取消/)
  const redir = await call('/api/send', { url: `${base}/api/r302` })
  assert.equal(redir.finalUrl, `${base}/api/ping`)

  const batch = await call('/api/batch', { url: `${base}/api/slow`, times: 20, concurrency: 20, timeout: 5 })
  assert.equal(batch.ok, 20)
  assert.ok(batch.wall < 1200, `服务端 20 并发应远快于串行 8s，实际 ${batch.wall}ms`)
  const batchAbort = call('/api/batch', { url: `${base}/api/slow`, times: 20, concurrency: 20, id: 'b1' })
  await new Promise((r) => setTimeout(r, 120))
  await call('/api/abort', { id: 'b1' })
  assert.equal((await batchAbort).aborted, true)

  const evil = await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.status, 403)

  await writeState(emptyState())
  await unlink(DATA).catch(() => {})
  console.log('selftest ok')
  server.close()
} else {
  const port = Number(process.env.PORT || 8799)
  server.listen(port, '127.0.0.1', () => {
    console.log(`接口调试工具 → http://127.0.0.1:${port}`)
    console.log(`数据文件: ${DATA}`)
  })
}
