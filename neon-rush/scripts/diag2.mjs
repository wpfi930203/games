/**
 * 验证假设：静态刚体 AABB 未更新 -> broadphase aabbQuery 漏检 -> 轮子射线打空。
 * 用法：node scripts/diag2.mjs [url] [mode]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2] || 'http://localhost:4173/'
const MODE = process.argv[3] || 'race'
const PORT = 9345

const profile = mkdtempSync(join(tmpdir(), 'chrome-diag2-'))
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(4500)
await evalJs(`(() => {
  document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c.dataset.mode === '${MODE}'))
  window.game.modeId = '${MODE}'
  document.getElementById('btn-start').click()
})()`)
await sleep(2500)
await evalJs(`window.game.mode.countdown = 0`)
await sleep(500)

// 在页面里装一套探针
await evalJs(`window.__probe = () => {
  const g = window.game, v = g.mode.player
  const V3 = v.body.position.constructor
  const RR = v.raycast.wheelInfos[0].raycastResult.constructor
  const w = v.raycast.wheelInfos[0]
  const src = new V3(w.chassisConnectionPointWorld.x, w.chassisConnectionPointWorld.y, w.chassisConnectionPointWorld.z)
  const d = w.directionWorld
  const L = w.suspensionRestLength + w.radius
  const tgt = new V3(src.x + d.x*L, src.y + d.y*L, src.z + d.z*L)
  const res = new RR()
  const hit = g.physics.world.rayTest(src, tgt, res)
  return { hit, body: res.body ? (res.body.surfaceType || 'body') : null, dist: +(res.distance||-1).toFixed(3) }
}; 'ok'`)

const aabbInfo = await evalJs(`(() => {
  const g = window.game, w = g.physics.world
  const v = g.mode.player
  const p = v.body.position
  // 地面平面
  const plane = w.bodies[0]
  // 车下最近的 road box
  let near = null, best = 1e9
  for (const b of w.bodies) {
    if (b.surfaceType === 'road') {
      const d = (b.position.x-p.x)**2 + (b.position.z-p.z)**2
      if (d < best) { best = d; near = b }
    }
  }
  const bb = (b) => ({
    pos: [+b.position.x.toFixed(2), +b.position.y.toFixed(2), +b.position.z.toFixed(2)],
    aabbY: [+b.aabb.lowerBound.y.toFixed(2), +b.aabb.upperBound.y.toFixed(2)],
    aabbX: [+b.aabb.lowerBound.x.toFixed(1), +b.aabb.upperBound.x.toFixed(1)],
    aabbZ: [+b.aabb.lowerBound.z.toFixed(1), +b.aabb.upperBound.z.toFixed(1)],
    needs: b.aabbNeedsUpdate,
    type: b.type,
    shape: b.shapes[0].constructor.name,
    sleep: b.sleepState,
  })
  // 统计有多少静态体的 aabb 与 pos 不符
  let stale = 0, total = 0
  for (const b of w.bodies) {
    if (b.mass === 0 && b.shapes[0] && b.shapes[0].halfExtents) {
      total++
      const midY = (b.aabb.lowerBound.y + b.aabb.upperBound.y) / 2
      if (Math.abs(midY - b.position.y) > 0.05) stale++
    }
  }
  return {
    plane: bb(plane),
    planeSurface: plane.surfaceType,
    nearRoad: near ? bb(near) : null,
    nearRoadSurface: near ? near.surfaceType : null,
    staticStaleAABB: stale + '/' + total,
    carPos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
  }
})()`)
console.log('=== AABB 体检 ===')
console.log(JSON.stringify(aabbInfo, null, 1))

const before = await evalJs(`window.__probe()`)
console.log('刷新 AABB 前 射线:', JSON.stringify(before))

await evalJs(`(() => {
  const w = window.game.physics.world
  for (const b of w.bodies) { b.aabbNeedsUpdate = true; b.updateAABB() }
  return 'ok'
})()`)

const after = await evalJs(`window.__probe()`)
console.log('刷新 AABB 后 射线:', JSON.stringify(after))

console.log('=== 刷新 AABB 后步进物理 ===')
for (let k = 0; k < 4; k++) {
  await evalJs(`(() => {
    const v = window.game.mode.player
    v.raycast.applyEngineForce(-3400, 2); v.raycast.applyEngineForce(-3400, 3)
    for (let i = 0; i < 60; i++) window.game.physics.world.step(1/60)
  })()`)
  const st = await evalJs(`(() => {
    const v = window.game.mode.player
    return {
      pos: [+v.body.position.x.toFixed(2), +v.body.position.y.toFixed(2), +v.body.position.z.toFixed(2)],
      vel: [+v.body.velocity.x.toFixed(2), +v.body.velocity.y.toFixed(2), +v.body.velocity.z.toFixed(2)],
      grounded: v.raycast.numWheelsOnGround,
    }
  })()`)
  console.log(`step ${(k + 1) * 60}:`, JSON.stringify(st))
}

console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===')
console.log(pageErrors.slice(0, 8).join('\n---\n') || 'none')
ws.close()
proc.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* noop */ }
