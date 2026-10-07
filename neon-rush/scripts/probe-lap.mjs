/**
 * 探明：赛道长度 / 玩家出生 s / 圈数为何变成 -1。
 * 用法：node scripts/probe-lap.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL =
  process.argv[2] ||
  'file:///C:/Users/fiona/WorkBuddy/2026-09-09-17-43-05/NEON-RUSH-单文件版.html'
const PORT = 9361

const profile = mkdtempSync(join(tmpdir(), 'chrome-probe-'))
const proc = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1024,640',
    'about:blank',
  ],
  { stdio: 'ignore' }
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  throw new Error('无法连接 Chrome 调试端口')
}
const ws = new WebSocket(await getTarget())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1024,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL })
await sleep(5000)

await evalJs(`(() => {
  document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === 'race'))
  window.game.modeId = 'race'
  document.getElementById('btn-start').click()
})()`)
await sleep(4000)

console.log(
  JSON.stringify(
    await evalJs(`(() => {
      const g = window.game, t = g.track, m = g.mode
      const p0 = t.points[0]
      return {
        赛道长度: +t.length.toFixed(1),
        采样数: t.points.length,
        points0: [+p0.x.toFixed(2), +p0.z.toFixed(2)],
        startPosition: [+t.startPosition.x.toFixed(2), +t.startPosition.z.toFixed(2)],
        玩家位置: [+m.player.body.position.x.toFixed(2), +m.player.body.position.z.toFixed(2)],
        玩家投影: (() => { const pr = t.project(m.player.body.position.x, m.player.body.position.z); return { s: +pr.s.toFixed(1), idx: pr.index, lateral: +pr.lateral.toFixed(2) } })(),
        racers: m.racers.map(r => ({
          name: r.name,
          laps: r.laps,
          s: +r.s.toFixed(1),
          total: +r.total.toFixed(1),
        })),
      }
    })()`),
    null,
    1
  )
)

// 长按 W 20 秒，观察 s / laps 变化
await evalJs(`window.__k=(c,d)=>window.dispatchEvent(new KeyboardEvent(d?'keydown':'keyup',{code:c,bubbles:true}));window.__k('KeyW',true)`)
for (let i = 0; i < 10; i++) {
  await sleep(2000)
  console.log(
    await evalJs(`(() => {
      const g = window.game, m = g.mode, r = m.racers[0]
      return 't=' + g.mode.raceTime.toFixed(1) + 's  s=' + r.s.toFixed(1) + '  laps=' + r.laps + '  v=' + Math.round(m.player.speedKmh) + 'km/h  wrongWay=' + r.wrongWay
    })()`)
  )
}
await evalJs(`window.__k('KeyW',false)`)

ws.close()
proc.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* noop */
}
