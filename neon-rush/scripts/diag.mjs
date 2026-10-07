/**
 * 物理隔离诊断：手动步进物理世界 + 手动射线检测，绕开游戏循环/输入/倒计时。
 * 用法：node scripts/diag.mjs [url] [mode]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2] || 'http://localhost:4173/'
const MODE = process.argv[3] || 'race'
const PORT = 9344

const profile = mkdtempSync(join(tmpdir(), 'chrome-diag-'))
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
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
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
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
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
await sleep(4500)

await evalJs(`(() => {
  document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === '${MODE}'))
  window.game.modeId = '${MODE}'
  document.getElementById('btn-start').click()
})()`)
await sleep(2500)
await evalJs(`window.game.mode.countdown = 0`)

// ---------- 1. 手动射线检测 ----------
const rayProbe = `(() => {
  const g = window.game, v = g.mode.player
  const V3 = v.body.position.constructor
  const RR = v.raycast.wheelInfos[0].raycastResult.constructor
  const w = v.raycast.wheelInfos[0]
  const src = new V3(w.chassisConnectionPointWorld.x, w.chassisConnectionPointWorld.y, w.chassisConnectionPointWorld.z)
  const raylen = w.suspensionRestLength + w.radius
  const d = w.directionWorld
  const tgt = new V3(src.x + d.x*raylen, src.y + d.y*raylen, src.z + d.z*raylen)
  const res = new RR()
  const hit = g.physics.world.rayTest(src, tgt, res)
  const res2 = new RR()
  const hit2 = g.physics.world.rayTest(new V3(src.x, 6, src.z), new V3(src.x, -6, src.z), res2)
  let near = null, best = 1e9
  for (const b of g.physics.world.bodies) {
    if (b.mass === 0 && b.shapes[0] && b.shapes[0].halfExtents) {
      const dd = (b.position.x - src.x)**2 + (b.position.z - src.z)**2
      if (dd < best) { best = dd; near = b }
    }
  }
  return {
    mode: '${MODE}',
    src: [+src.x.toFixed(2), +src.y.toFixed(2), +src.z.toFixed(2)],
    tgt: [+tgt.x.toFixed(2), +tgt.y.toFixed(2), +tgt.z.toFixed(2)],
    dirWorld: [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2)],
    raylen,
    rayA: { hit, dist: +(res.distance||-1).toFixed(3), body: res.body ? (res.body.surfaceType||'body') : null, y: res.hitPointWorld ? +res.hitPointWorld.y.toFixed(3) : null },
    rayB: { hit: hit2, dist: +(res2.distance||-1).toFixed(3), body: res2.body ? (res2.body.surfaceType||'body') : null, y: res2.hitPointWorld ? +res2.hitPointWorld.y.toFixed(3) : null },
    bodies: g.physics.world.bodies.length,
    axisLen: g.physics.world.broadphase.axisList ? g.physics.world.broadphase.axisList.length : -1,
    broadphase: g.physics.world.broadphase.constructor.name,
    nearBox: near ? {
      pos: [+near.position.x.toFixed(2), +near.position.y.toFixed(2), +near.position.z.toFixed(2)],
      he: near.shapes[0].halfExtents ? [+near.shapes[0].halfExtents.x.toFixed(2), +near.shapes[0].halfExtents.y.toFixed(2), +near.shapes[0].halfExtents.z.toFixed(2)] : null,
      aabbY: [+near.aabb.lowerBound.y.toFixed(2), +near.aabb.upperBound.y.toFixed(2)],
      surface: near.surfaceType || '(none)',
      collisionResponse: near.collisionResponse,
      cfg: near.collisionFilterGroup, cfm: near.collisionFilterMask,
      shape: near.shapes[0].constructor.name,
    } : null,
  }
})()`
console.log('=== 1) 手动射线检测 ===')
console.log(JSON.stringify(await evalJs(rayProbe), null, 1))

// ---------- 2. 手动步进纯物理 ----------
console.log('=== 2) 手动步进物理（直接给后轮推力）===')
const before = await evalJs(`(() => {
  const v = window.game.mode.player
  v.raycast.applyEngineForce(-3400, 2)
  v.raycast.applyEngineForce(-3400, 3)
  return { pos: [+v.body.position.x.toFixed(2), +v.body.position.y.toFixed(2), +v.body.position.z.toFixed(2)] }
})()`)
console.log('before:', JSON.stringify(before))
for (let k = 0; k < 6; k++) {
  await evalJs(`(() => { for (let i = 0; i < 60; i++) window.game.physics.world.step(1/60) })()`)
  const st = await evalJs(`(() => {
    const v = window.game.mode.player
    const w0 = v.raycast.wheelInfos[0]
    return {
      pos: [+v.body.position.x.toFixed(2), +v.body.position.y.toFixed(2), +v.body.position.z.toFixed(2)],
      vel: [+v.body.velocity.x.toFixed(2), +v.body.velocity.y.toFixed(2), +v.body.velocity.z.toFixed(2)],
      speedKmh: Math.round(v.speedKmh),
      grounded: v.raycast.numWheelsOnGround,
      contact0: w0.isInContact,
      body0: w0.raycastResult.body ? (w0.raycastResult.body.surfaceType || 'body') : null,
      sus0: +w0.suspensionLength.toFixed(3),
      connY0: +w0.chassisConnectionPointWorld.y.toFixed(3),
    }
  })()`)
  console.log(`step ${(k + 1) * 60}:`, JSON.stringify(st))
}

console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===')
console.log(pageErrors.slice(0, 8).join('\n---\n') || 'none')

ws.close()
proc.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* noop */
}
