import * as THREE from 'three'

export interface CarMesh {
  group: THREE.Group
  /** 修改车漆颜色 */
  setColor(hex: number): void
  /** 刹车灯亮度 0..1 */
  setBrake(intensity: number): void
  /** 氮气/尾焰强度 0..1 */
  setBoost(intensity: number): void
  /** 半透明（幽灵车） */
  setGhost(on: boolean): void
  dispose(): void
}

const WHEEL_RADIUS = 0.38
const WHEEL_WIDTH = 0.34

/** 由侧视轮廓挤出生成低多边形车身（车头朝向 +Z） */
function extrudeProfile(points: [number, number][], width: number, depthOffset = 0) {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1])
  shape.closePath()

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.05,
    bevelThickness: 0.05,
    steps: 1,
  })
  // 挤出方向为 +Z（车宽），把长度轴旋转到 +Z（车长）
  geo.rotateY(-Math.PI / 2)
  geo.translate(width / 2 + depthOffset, 0, 0)
  geo.computeVertexNormals()
  return geo
}

const BODY_PROFILE: [number, number][] = [
  [-2.05, -0.04],
  [-2.02, 0.3],
  [-1.86, 0.5],
  [-1.0, 0.56],
  [-0.1, 0.58],
  [0.9, 0.52],
  [1.62, 0.4],
  [2.0, 0.2],
  [2.05, -0.04],
  [1.9, -0.2],
  [1.1, -0.26],
  [-1.1, -0.3],
  [-1.95, -0.26],
]

const CANOPY_PROFILE: [number, number][] = [
  [-1.15, 0.5],
  [-0.5, 0.92],
  [0.25, 0.96],
  [0.92, 0.62],
  [0.9, 0.5],
]

export function createCarMesh(color = 0x37f5d8, isPlayer = true): CarMesh {
  const group = new THREE.Group()
  group.name = isPlayer ? 'player-car' : 'car'

  const paint = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.55,
    roughness: 0.32,
    flatShading: true,
  })
  const dark = new THREE.MeshStandardMaterial({
    color: 0x14161f,
    metalness: 0.3,
    roughness: 0.8,
    flatShading: true,
  })
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0b2030,
    metalness: 0.9,
    roughness: 0.08,
    transparent: true,
    opacity: 0.85,
    flatShading: true,
  })
  const rubber = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.95 })
  const rim = new THREE.MeshStandardMaterial({ color: 0xc9d4dd, metalness: 0.9, roughness: 0.25 })
  const headlight = new THREE.MeshStandardMaterial({
    color: 0xfff6d6,
    emissive: 0xfff2c0,
    emissiveIntensity: 2,
  })
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x5a0713,
    emissive: 0xff2244,
    emissiveIntensity: 0.6,
  })
  const boostMat = new THREE.MeshBasicMaterial({
    color: 0x49d8ff,
    transparent: true,
    opacity: 0,
  })

  const materials: THREE.Material[] = [paint, dark, glass, rubber, rim, headlight, tailMat, boostMat]

  // ---- 车身 ----
  const body = new THREE.Mesh(extrudeProfile(BODY_PROFILE, 1.55), paint)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // 侧裙
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 2.6), dark)
  skirt.position.set(0, -0.24, 0)
  skirt.castShadow = true
  group.add(skirt)

  // ---- 座舱 ----
  const canopy = new THREE.Mesh(extrudeProfile(CANOPY_PROFILE, 1.25), glass)
  canopy.castShadow = true
  group.add(canopy)

  // ---- 尾翼 ----
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.42), dark)
  wing.position.set(0, 0.82, -1.92)
  wing.rotation.x = 0.18
  wing.castShadow = true
  group.add(wing)
  for (const sx of [-0.62, 0.62]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.16), dark)
    strut.position.set(sx, 0.62, -1.88)
    group.add(strut)
  }

  // ---- 前铲 / 扩散器 ----
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.36), dark)
  splitter.position.set(0, -0.26, 1.98)
  splitter.castShadow = true
  group.add(splitter)
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.3), dark)
  diffuser.position.set(0, -0.16, -2.0)
  group.add(diffuser)

  // ---- 灯 ----
  for (const sx of [-0.55, 0.55]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.08), headlight)
    hl.position.set(sx, 0.16, 2.03)
    group.add(hl)
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.08), tailMat)
    tl.position.set(sx, 0.24, -2.04)
    group.add(tl)
  }

  // ---- 排气尾焰（氮气） ----
  const flames: THREE.Mesh[] = []
  for (const sx of [-0.34, 0.34]) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.9, 8, 1, true), boostMat)
    flame.rotation.x = -Math.PI / 2
    flame.position.set(sx, 0.02, -2.25)
    flame.visible = false
    group.add(flame)
    flames.push(flame)
  }

  // ---- 车轮 ----
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 14, 1)
  wheelGeo.rotateZ(Math.PI / 2)
  const rimGeo = new THREE.CylinderGeometry(WHEEL_RADIUS * 0.55, WHEEL_RADIUS * 0.55, WHEEL_WIDTH + 0.02, 8, 1)
  rimGeo.rotateZ(Math.PI / 2)

  const setBrake = (intensity: number) => {
    tailMat.emissiveIntensity = 0.6 + intensity * 5
  }
  const setBoost = (intensity: number) => {
    boostMat.opacity = intensity
    for (const f of flames) f.visible = intensity > 0.05
    for (const f of flames) f.scale.set(1, 0.5 + intensity * 1.6, 1)
  }
  const setColor = (hex: number) => {
    paint.color.setHex(hex)
  }
  const setGhost = (on: boolean) => {
    for (const m of materials) {
      m.transparent = on ? true : m === glass || m === boostMat
      m.opacity = on ? 0.35 : m === glass ? 0.85 : m === boostMat ? 0 : 1
      m.depthWrite = !on
      m.needsUpdate = true
    }
  }

  return {
    group,
    setColor,
    setBrake,
    setBoost,
    setGhost,
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
      for (const m of materials) m.dispose()
    },
  }
}

/** 单个车轮网格（轴沿 X） */
export function createWheelMesh(): THREE.Group {
  const g = new THREE.Group()
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 14, 1),
    new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.95, flatShading: true })
  )
  tire.geometry.rotateZ(Math.PI / 2)
  tire.castShadow = true
  g.add(tire)

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(WHEEL_RADIUS * 0.55, WHEEL_RADIUS * 0.55, WHEEL_WIDTH + 0.03, 8, 1),
    new THREE.MeshStandardMaterial({ color: 0xbfc9d2, metalness: 0.85, roughness: 0.3, flatShading: true })
  )
  rim.geometry.rotateZ(Math.PI / 2)
  g.add(rim)

  // 轮辐（低多边形感）
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(WHEEL_WIDTH * 0.72, WHEEL_RADIUS * 0.9, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x8e99a4, metalness: 0.7, roughness: 0.4 })
    )
    spoke.rotation.x = (i * Math.PI) / 4
    g.add(spoke)
  }
  return g
}

export const WHEEL_R = WHEEL_RADIUS
