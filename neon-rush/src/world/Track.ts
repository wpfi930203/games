import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { PhysicsWorld, SurfaceBody } from '../physics/PhysicsWorld'
import { clamp } from '../utils/math'

/** 赛道中心线控制点（XZ 平面，闭合回路） */
const CONTROL_POINTS: [number, number][] = [
  [0, 0],
  [62, -14],
  [116, -52],
  [140, -112],
  [126, -172],
  [78, -214],
  [16, -222],
  [-40, -196],
  [-62, -150],
  [-44, -112],
  [-84, -78],
  [-140, -46],
  [-146, 18],
  [-108, 62],
  [-52, 74],
  [-6, 52],
]

export const ROAD_WIDTH = 15
const SAMPLES = 240
const WALL_EVERY = 4
const WALL_HEIGHT = 1.3

export class Track {
  curve: THREE.CatmullRomCurve3
  length = 0
  width = ROAD_WIDTH
  group = new THREE.Group()
  bodies: CANNON.Body[] = []

  /** 等距采样点 */
  points: THREE.Vector3[] = []
  tangents: THREE.Vector3[] = []
  /** 累积弧长 */
  sAt: number[] = []
  center2D: THREE.Vector2[] = []

  startPosition = new THREE.Vector3()
  startHeading = 0

  constructor() {
    const pts = CONTROL_POINTS.map(
      ([x, z]) => new THREE.Vector3(x, 0, z)
    )
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5)
    this.sampleCurve()
  }

  private sampleCurve() {
    const raw = this.curve.getSpacedPoints(SAMPLES) // 返回 SAMPLES+1 个点（首尾重合）
    this.points = raw.slice(0, SAMPLES)
    this.tangents = this.points.map((_, i) => {
      const next = this.points[(i + 1) % SAMPLES]
      const prev = this.points[(i - 1 + SAMPLES) % SAMPLES]
      return next.clone().sub(prev).normalize()
    })
    let s = 0
    this.sAt = []
    for (let i = 0; i < SAMPLES; i++) {
      this.sAt.push(s)
      s += this.points[i].distanceTo(this.points[(i + 1) % SAMPLES])
    }
    this.length = s
    this.center2D = this.points.map((p) => new THREE.Vector2(p.x, p.z))

    const p0 = this.points[0]
    const t0 = this.tangents[0]
    this.startPosition.set(p0.x, 1.2, p0.z)
    this.startHeading = Math.atan2(t0.x, t0.z)
  }

  /** 局部右向量（与 up × forward 一致） */
  rightAt(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.tangents[(index + SAMPLES) % SAMPLES]
    return out.set(t.z, 0, -t.x).normalize()
  }

  // ------------------------------------------------------------------
  /** 最近采样点索引（hint 附近做局部搜索，无 hint 时全局搜索） */
  nearestIndex(x: number, z: number, hint = -1): number {
    const n = SAMPLES
    let best = -1
    let bestD = Infinity
    if (hint >= 0) {
      for (let k = -30; k <= 30; k++) {
        const i = (hint + k + n) % n
        const p = this.center2D[i]
        const d = (p.x - x) ** 2 + (p.y - z) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      // 局部搜索结果偏离过大时退化为全局搜索
      if (bestD < 60 * 60) return best
    }
    for (let i = 0; i < n; i++) {
      const p = this.center2D[i]
      const d = (p.x - x) ** 2 + (p.y - z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** 到中心线的最短距离 */
  distanceToCenter(x: number, z: number): number {
    const i = this.nearestIndex(x, z)
    return Math.sqrt((this.center2D[i].x - x) ** 2 + (this.center2D[i].y - z) ** 2)
  }

  /**
   * 把世界坐标投影到赛道上
   * @returns s 沿赛道弧长, lateral 横向偏移（右为正）, heading 赛道朝向
   */
  project(x: number, z: number, hint = -1) {
    const n = SAMPLES
    const i = this.nearestIndex(x, z, hint)
    const a = this.points[i]
    const b = this.points[(i + 1) % n]
    const abx = b.x - a.x
    const abz = b.z - a.z
    const len2 = abx * abx + abz * abz || 1
    let t = ((x - a.x) * abx + (z - a.z) * abz) / len2
    t = clamp(t, 0, 1)
    const px = a.x + abx * t
    const pz = a.z + abz * t
    const right = this.rightAt(i)
    const lateral = (x - px) * right.x + (z - pz) * right.z
    const segLen = Math.sqrt(len2)
    const s = (this.sAt[i] + segLen * t) % this.length
    const heading = Math.atan2(this.tangents[i].x, this.tangents[i].z)
    return { s, index: i, lateral, heading }
  }

  /** 按弧长取点 */
  pointAtS(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = SAMPLES
    let ss = s % this.length
    if (ss < 0) ss += this.length
    // 二分查找
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.sAt[mid] <= ss) lo = mid
      else hi = mid - 1
    }
    const i = lo
    const j = (i + 1) % n
    const segLen = this.sAt[j] > this.sAt[i] ? this.sAt[j] - this.sAt[i] : this.length - this.sAt[i]
    const t = segLen > 0 ? (ss - this.sAt[i]) / segLen : 0
    return out.lerpVectors(this.points[i], this.points[j], clamp(t, 0, 1))
  }

  headingAtS(s: number): number {
    const i = this.indexAtS(s)
    const t = this.tangents[i]
    return Math.atan2(t.x, t.z)
  }

  indexAtS(s: number): number {
    const n = SAMPLES
    let ss = s % this.length
    if (ss < 0) ss += this.length
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.sAt[mid] <= ss) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** 在赛道上取一个带横向偏移的复位点 */
  resetPointAtS(s: number, lateral = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.pointAtS(s, out)
    const i = this.indexAtS(s)
    const right = this.rightAt(i)
    p.x += right.x * lateral
    p.z += right.z * lateral
    p.y = 1.2
    return p
  }
}

// ======================================================================
//  程序化贴图
// ======================================================================

function makeAsphaltTexture(): THREE.CanvasTexture {
  const size = 512
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#24262c'
  g.fillRect(0, 0, size, size)
  // 噪点
  for (let i = 0; i < 9000; i++) {
    const v = 24 + Math.random() * 34
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.16 + Math.random() * 0.3})`
    const r = 1 + Math.random() * 3
    g.fillRect(Math.random() * size, Math.random() * size, r, r)
  }
  // 边缘白线
  g.fillStyle = 'rgba(240,240,235,0.85)'
  g.fillRect(8, 0, 12, size)
  g.fillRect(size - 20, 0, 12, size)
  // 中央虚线
  g.fillStyle = 'rgba(255,240,190,0.75)'
  for (let y = 0; y < size; y += 96) g.fillRect(size / 2 - 5, y, 10, 54)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  return tex
}

function makeCheckerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 32
  const g = c.getContext('2d')!
  const cell = 16
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#f2f2f2' : '#141519'
      g.fillRect(x * cell, y * cell, cell, cell)
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// ======================================================================
//  构建赛道（视觉 + 物理）
// ======================================================================

export interface TrackBuildOptions {
  /** 是否生成护栏（计时赛/竞速需要，竞技场不需要） */
  barriers: boolean
}

export function buildTrack(
  scene: THREE.Scene,
  physics: PhysicsWorld,
  track: Track,
  opts: TrackBuildOptions = { barriers: true }
): THREE.Group {
  const group = track.group
  group.name = 'track'
  scene.add(group)

  const n = track.points.length
  const hw = ROAD_WIDTH / 2

  // ---------- 路面 ----------
  const roadPos: number[] = []
  const roadUv: number[] = []
  const roadIdx: number[] = []
  let s = 0
  for (let i = 0; i <= n; i++) {
    const idx = i % n
    const p = track.points[idx]
    const right = track.rightAt(idx)
    const v = s / 7
    roadPos.push(p.x - right.x * hw, 0.02, p.z - right.z * hw)
    roadPos.push(p.x + right.x * hw, 0.02, p.z + right.z * hw)
    roadUv.push(0, v, 1, v)
    if (i > 0) {
      const a = (i - 1) * 2
      roadIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    s += p.distanceTo(track.points[(idx + 1) % n])
  }
  const roadGeo = new THREE.BufferGeometry()
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3))
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roadUv, 2))
  roadGeo.setIndex(roadIdx)
  roadGeo.computeVertexNormals()
  const roadMat = new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(),
    roughness: 0.92,
    metalness: 0.05,
  })
  const road = new THREE.Mesh(roadGeo, roadMat)
  road.receiveShadow = true
  group.add(road)

  // ---------- 路肩（红白相间） ----------
  const curbPos: number[] = []
  const curbCol: number[] = []
  const curbIdx: number[] = []
  let vi = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const p = track.points[i]
    const p2 = track.points[j]
    const r = track.rightAt(i)
    const r2 = track.rightAt(j)
    const on = i % 4 < 2
    const color = on ? [0.92, 0.16, 0.24] : [0.95, 0.95, 0.95]
    for (const side of [-1, 1]) {
      const o1 = hw + 0.0
      const o2 = hw + 1.1
      const a = [p.x + r.x * o1 * side, 0.04, p.z + r.z * o1 * side]
      const b = [p.x + r.x * o2 * side, 0.03, p.z + r.z * o2 * side]
      const c = [p2.x + r2.x * o1 * side, 0.04, p2.z + r2.z * o1 * side]
      const d = [p2.x + r2.x * o2 * side, 0.03, p2.z + r2.z * o2 * side]
      curbPos.push(...a, ...b, ...c, ...d)
      for (let k = 0; k < 4; k++) curbCol.push(...color)
      curbIdx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3)
      vi += 4
    }
  }
  const curbGeo = new THREE.BufferGeometry()
  curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPos, 3))
  curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(curbCol, 3))
  curbGeo.setIndex(curbIdx)
  curbGeo.computeVertexNormals()
  const curb = new THREE.Mesh(
    curbGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })
  )
  curb.receiveShadow = true
  group.add(curb)

  // ---------- 护栏（视觉 + 物理） ----------
  if (opts.barriers) {
    const wallPos: number[] = []
    const wallCol: number[] = []
    const wallIdx: number[] = []
    let wvi = 0
    const wallOffset = hw + 1.6
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const p = track.points[i]
      const p2 = track.points[j]
      const r = track.rightAt(i)
      const r2 = track.rightAt(j)
      const on = Math.floor(i / 3) % 2 === 0
      const color = on ? [0.85, 0.2, 0.28] : [0.9, 0.9, 0.92]
      for (const side of [-1, 1]) {
        const ax = p.x + r.x * wallOffset * side
        const az = p.z + r.z * wallOffset * side
        const bx = p2.x + r2.x * wallOffset * side
        const bz = p2.z + r2.z * wallOffset * side
        wallPos.push(ax, 0.05, az, ax, WALL_HEIGHT, az, bx, 0.05, bz, bx, WALL_HEIGHT, bz)
        for (let k = 0; k < 4; k++) wallCol.push(...color)
        wallIdx.push(wvi, wvi + 2, wvi + 1, wvi + 1, wvi + 2, wvi + 3)
        wvi += 4

        // 物理：每 WALL_EVERY 个采样放一块挡板，长度必须真的跨越这段，否则会留下缺口
        if (i % WALL_EVERY === 0) {
          const endIdx = (i + WALL_EVERY) % n
          const pe = track.points[endIdx]
          const re = track.rightAt(endIdx)
          const ex = pe.x + re.x * wallOffset * side
          const ez = pe.z + re.z * wallOffset * side
          const mid = new THREE.Vector3((ax + ex) / 2, WALL_HEIGHT / 2, (az + ez) / 2)
          const dx = ex - ax
          const dz = ez - az
          const len = Math.hypot(dx, dz) + 0.6
          const body = new CANNON.Body({
            mass: 0,
            material: physics.materials.wall,
            shape: new CANNON.Box(new CANNON.Vec3(len / 2, WALL_HEIGHT / 2, 0.28)),
          }) as SurfaceBody
          body.surfaceType = 'wall'
          body.position.set(mid.x, mid.y, mid.z)
          body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(dx, dz) + Math.PI / 2)
          physics.world.addBody(body)
          track.bodies.push(body)
        }
      }
    }
    const wallGeo = new THREE.BufferGeometry()
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3))
    wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wallCol, 3))
    wallGeo.setIndex(wallIdx)
    wallGeo.computeVertexNormals()
    const wall = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.35,
        side: THREE.DoubleSide,
      })
    )
    wall.castShadow = true
    wall.receiveShadow = true
    group.add(wall)

    // 护栏立柱（实例化）
    const postGeo = new THREE.BoxGeometry(0.12, WALL_HEIGHT + 0.4, 0.12)
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6, metalness: 0.5 })
    const posts = new THREE.InstancedMesh(postGeo, postMat, n * 2)
    posts.castShadow = true
    const m4 = new THREE.Matrix4()
    let pi = 0
    for (let i = 0; i < n; i += 2) {
      const p = track.points[i]
      const r = track.rightAt(i)
      for (const side of [-1, 1]) {
        m4.makeTranslation(p.x + r.x * wallOffset * side, (WALL_HEIGHT + 0.4) / 2, p.z + r.z * wallOffset * side)
        posts.setMatrixAt(pi++, m4)
      }
    }
    posts.count = pi
    posts.instanceMatrix.needsUpdate = true
    group.add(posts)
  }

  // ---------- 路面物理：沿赛道的薄盒 ----------
  const halfSeg = track.length / n / 2 + 0.35
  for (let i = 0; i < n; i++) {
    const p = track.points[i]
    const t = track.tangents[i]
    const body = new CANNON.Body({
      mass: 0,
      material: physics.materials.road,
      shape: new CANNON.Box(new CANNON.Vec3(hw, 0.15, halfSeg)),
    }) as SurfaceBody
    body.surfaceType = 'road'
    body.position.set(p.x, -0.13, p.z)
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(t.x, t.z))
    physics.world.addBody(body)
    track.bodies.push(body)
  }

  // ---------- 起跑线 ----------
  const startTex = makeCheckerTexture()
  startTex.repeat.set(6, 1)
  const startGeo = new THREE.PlaneGeometry(ROAD_WIDTH, 3)
  const startLine = new THREE.Mesh(
    startGeo,
    new THREE.MeshStandardMaterial({ map: startTex, roughness: 0.8 })
  )
  startLine.rotation.x = -Math.PI / 2
  startLine.position.set(track.points[0].x, 0.05, track.points[0].z)
  startLine.rotation.z = -track.startHeading
  group.add(startLine)

  // 起跑门
  const gateMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.6, roughness: 0.4 })
  const gate = new THREE.Group()
  const bar = new THREE.Mesh(new THREE.BoxGeometry(ROAD_WIDTH + 6, 1.1, 0.5), gateMat)
  bar.position.y = 7
  gate.add(bar)
  for (const sx of [-(ROAD_WIDTH / 2 + 2.4), ROAD_WIDTH / 2 + 2.4]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7, 0.7), gateMat)
    pillar.position.set(sx, 3.5, 0)
    gate.add(pillar)
  }
  gate.position.set(track.points[0].x, 0, track.points[0].z)
  gate.rotation.y = track.startHeading
  group.add(gate)

  return group
}

export { SAMPLES as TRACK_SAMPLES }
