/**
 * 端到端：真的按 W 键，看车动不动。
 * 用法：node scripts/diag3.mjs [url] [mode]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2] || 'file:///C:/Users/fiona/WorkBuddy/2026-09-09-17-43-05/NEON-RUSH-单文件版.html'
const MODE = process.argv[3] || 'race'
const PORT = 9351

const profile = mkdtempSync(join(tmpdir(), 'chrome-diag3-'))
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
const pageErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    pageErrors.push(d.exception?.description || d.text || 'unknown')
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

const key = (type, code, keyChar, vk) =>
  send('Input.dispatchKeyEvent', {
    type,
    code,
    key: keyChar,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  })

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

console.log('game 存在:', await evalJs(`typeof window.game`))
console.log(
  '启动前状态:',
  JSON.stringify(await evalJs(`({hasGame: !!window.game, hasMode: !!(window.game&&window.game.mode)})`))
)

await evalJs(`(() => {
  document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === '${MODE}'))
  window.game.modeId = '${MODE}'
  document.getElementById('btn-start').click()
})()`)
// 等倒计时自然结束（模拟真人流程），不人为清零
console.log('BUILD_TAG:', await evalJs(`window.BUILD_TAG || document.getElementById('build-stamp').textContent`))
for (let i = 0; i < 40; i++) {
  const cd = await evalJs(`window.game.mode ? window.game.mode.countdown : 99`)
  if (cd <= 0) break
  await sleep(500)
}
await sleep(300)

const probe = `(() => {
  const g = window.game
  const v = g.mode.player
  if (!v) return { err: 'no player' }
  const p = v.body.position
  let stale = 0, total = 0
  for (const b of g.physics.world.bodies) {
    if (b.mass === 0 && b.shapes[0] && b.shapes[0].halfExtents) {
      total++
      const midY = (b.aabb.lowerBound.y + b.aabb.upperBound.y) / 2
      if (Math.abs(midY - b.position.y) > 0.05) stale++
    }
  }
  const w0 = v.raycast.wheelInfos[0]
  const V3 = p.constructor
  const RR = w0.raycastResult.constructor
  const src = new V3(w0.chassisConnectionPointWorld.x, w0.chassisConnectionPointWorld.y, w0.chassisConnectionPointWorld.z)
  const d = w0.directionWorld
  const L = w0.suspensionRestLength + w0.radius
  const tgt = new V3(src.x + d.x*L, src.y + d.y*L, src.z + d.z*L)
  const res = new RR()
  g.physics.world.rayTest(src, tgt, res)
  return {
    pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
    speedKmh: +v.speedKmh.toFixed(1),
    grounded: v.raycast ? v.raycast.numWheelsOnGround : -1,
    rayHit: !!res.body,
    raySurface: res.body ? (res.body.surfaceType || 'body') : null,
    rayDist: +(res.distance || -1).toFixed(3),
    staleAABB: stale + '/' + total,
    countdown: +g.mode.countdown.toFixed(2),
    raceState: g.state,
    lap: g.mode.racers ? g.mode.racers[0].laps : 'n/a',
    trackS: g.mode.racers ? +g.mode.racers[0].s.toFixed(1) : 'n/a',
    engineForces: v.raycast.wheelInfos.map(w => Math.round(w.engineForce || 0)),
    input: (() => {
      try {
        const s = g.input && (g.input.state || g.input.keys || g.input)
        return JSON.parse(JSON.stringify(s))
      } catch (e) {
        return 'unserializable:' + String(e)
      }
    })(),
    fuse: v.fuseOk === undefined ? 'n/a' : v.fuseOk,
  }
})()`

console.log('=== 按 W 之前 ===')
console.log(JSON.stringify(await evalJs(probe), null, 1))

// 真的按下 W
await key('keyDown', 'KeyW', 'w', 87)
await sleep(9000)

console.log('=== 按住 W 3 秒后 ===')
console.log(JSON.stringify(await evalJs(probe), null, 1))

await key('keyUp', 'KeyW', 'w', 87)

// 再看看 HUD 速度
console.log(
  'HUD:',
  JSON.stringify(
    await evalJs(`(() => {
      const s = document.querySelector('#hud-speed, .hud-speed, #speed')
      return { speedEl: s ? s.textContent.trim() : null, bodyClass: document.body.className }
    })()`)
  )
)

console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===')
console.log(pageErrors.slice(0, 8).join('\n---\n') || 'none')
ws.close()
proc.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* noop */
}
