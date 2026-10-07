/**
 * 极简 CDP（Chrome DevTools Protocol）冒烟测试客户端 —— 零依赖。
 * 用法：node scripts/smoke-cdp.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2] || 'http://localhost:4173/'
const PORT = 9333
const SHOT_DIR = join(tmpdir(), 'neonrush-shots')
mkdirSync(SHOT_DIR, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'chrome-prof-'))
const proc = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,760',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  throw new Error('无法连接 Chrome 调试端口')
}

const wsUrl = await getTarget()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let msgId = 0
const pending = new Map()
const consoleLogs = []
const pageErrors = []

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    consoleLogs.push(`[${msg.params.type}] ${text}`)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    pageErrors.push(d.exception?.description || d.text || 'unknown')
  }
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: URL })
await sleep(4000)

const results = {}
for (const mode of ['race', 'timetrial', 'arena']) {
  await evalJs(`(() => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === '${mode}'))
    window.game.modeId = '${mode}'
    document.getElementById('btn-start').click()
  })()`)
  await sleep(5000)
  await evalJs(`window.__keys = (code, down) => window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup', {code, bubbles:true}))`)
  await evalJs(`window.__keys('KeyW', true); window.__keys('KeyA', true)`)
  await sleep(6000)
  await evalJs(`window.__keys('KeyW', false); window.__keys('KeyA', false)`)
  results[mode] = await evalJs(`(() => {
    const g = window.game, m = g.mode, p = m && m.player
    const pos = p && p.mesh.group.position
    return {
      state: g.state,
      speed: p ? Math.round(p.speedKmh) : -1,
      grounded: p ? p.groundedWheels : -1,
      pos: pos ? [pos.x.toFixed(1), pos.y.toFixed(1), pos.z.toFixed(1)].join(',') : 'n/a',
      vehicles: m ? m.vehicles.length : -1,
      fps: g.fpsValue,
      rendererInfo: g.renderer ? g.renderer.info.render.calls : -1,
    }
  })()`)
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(SHOT_DIR, `${mode}.png`), Buffer.from(shot.data, 'base64'))
    console.log(`[shot] ${SHOT_DIR}/${mode}.png`)
  } catch (e) {
    console.log('[shot] failed:', e.message)
  }
  await evalJs(`window.game.toMenu()`)
  await sleep(800)
}

console.log('=== STATES ===')
console.log(JSON.stringify(results, null, 2))
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===')
console.log(pageErrors.slice(0, 15).join('\n---\n') || 'none')
console.log('=== CONSOLE (last 25) ===')
console.log(consoleLogs.slice(-25).join('\n'))

ws.close()
proc.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* noop */
}
process.exit(pageErrors.length ? 1 : 0)
