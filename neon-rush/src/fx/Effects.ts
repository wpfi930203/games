import * as THREE from 'three'
import { clamp, randomRange } from '../utils/math'
import type { FxSink } from '../vehicle/Vehicle'

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (330.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = smoothstep(0.25, 0.015, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}
`

interface Particle {
  life: number
  maxLife: number
  vx: number
  vy: number
  vz: number
  gravity: number
  drag: number
  size0: number
  size1: number
  r: number
  g: number
  b: number
  alpha0: number
}

/** 单个粒子池（CPU 更新 + GPU 点渲染） */
class ParticlePool {
  points: THREE.Points
  private pos: Float32Array
  private col: Float32Array
  private size: Float32Array
  private alpha: Float32Array
  private parts: Particle[] = []
  private cursor = 0
  private capacity: number
  private emitAccumulator = 0

  constructor(scene: THREE.Scene, capacity: number, blending: THREE.Blending) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.col = new Float32Array(capacity * 3)
    this.size = new Float32Array(capacity)
    this.alpha = new Float32Array(capacity)
    for (let i = 0; i < capacity; i++) {
      this.parts.push({
        life: 0,
        maxLife: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        drag: 0,
        size0: 1,
        size1: 1,
        r: 1,
        g: 1,
        b: 1,
        alpha0: 1,
      })
      this.alpha[i] = 0
      this.size[i] = 0
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  emit(o: {
    x: number
    y: number
    z: number
    vx: number
    vy: number
    vz: number
    life: number
    size0: number
    size1: number
    color: THREE.Color
    alpha: number
    gravity?: number
    drag?: number
  }) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    const p = this.parts[i]
    p.life = o.life
    p.maxLife = o.life
    p.vx = o.vx
    p.vy = o.vy
    p.vz = o.vz
    p.gravity = o.gravity ?? 0
    p.drag = o.drag ?? 0.6
    p.size0 = o.size0
    p.size1 = o.size1
    p.r = o.color.r
    p.g = o.color.g
    p.b = o.color.b
    p.alpha0 = o.alpha
    this.pos[i * 3] = o.x
    this.pos[i * 3 + 1] = o.y
    this.pos[i * 3 + 2] = o.z
    this.col[i * 3] = p.r
    this.col[i * 3 + 1] = p.g
    this.col[i * 3 + 2] = p.b
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.parts[i]
      if (p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) {
        this.alpha[i] = 0
        this.size[i] = 0
        continue
      }
      const i3 = i * 3
      p.vy -= p.gravity * dt
      const d = Math.exp(-p.drag * dt)
      p.vx *= d
      p.vy *= d
      p.vz *= d
      this.pos[i3] += p.vx * dt
      this.pos[i3 + 1] += p.vy * dt
      this.pos[i3 + 2] += p.vz * dt
      const t = 1 - p.life / p.maxLife
      this.size[i] = p.size0 + (p.size1 - p.size0) * t
      this.alpha[i] = p.alpha0 * (1 - t * t)
    }
    const g = this.points.geometry
    ;(g.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true
  }

  /** 限制每秒发射量，避免低端设备过载 */
  throttle(dt: number, rate: number): boolean {
    this.emitAccumulator += dt * rate
    if (this.emitAccumulator >= 1) {
      this.emitAccumulator = 0
      return true
    }
    return false
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) {
      this.parts[i].life = 0
      this.alpha[i] = 0
      this.size[i] = 0
    }
    ;(this.points.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
  }
}

/** 冲击波圆环 */
class Shockwaves {
  private rings: THREE.Mesh[] = []
  private lives: number[] = []
  constructor(scene: THREE.Scene, count = 5) {
    const geo = new THREE.RingGeometry(0.6, 1, 32)
    geo.rotateX(-Math.PI / 2)
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0xffb057,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      )
      m.visible = false
      scene.add(m)
      this.rings.push(m)
      this.lives.push(0)
    }
  }
  spawn(pos: THREE.Vector3, scale: number) {
    for (let i = 0; i < this.rings.length; i++) {
      if (this.lives[i] <= 0) {
        this.rings[i].position.copy(pos)
        this.rings[i].position.y += 0.4
        this.rings[i].scale.setScalar(1)
        this.rings[i].visible = true
        this.lives[i] = 1
        ;(this.rings[i].material as THREE.MeshBasicMaterial).opacity = 0.85
        this.rings[i].userData.scale = scale
        return
      }
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.rings.length; i++) {
      if (this.lives[i] <= 0) continue
      this.lives[i] -= dt * 2.2
      const t = 1 - Math.max(0, this.lives[i])
      const s = (1 + t * 12) * (this.rings[i].userData.scale ?? 1)
      this.rings[i].scale.setScalar(s)
      ;(this.rings[i].material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - t))
      if (this.lives[i] <= 0) this.rings[i].visible = false
    }
  }
}

/**
 * 全部特效：轮胎烟雾、扬尘、火花、爆炸、氮气尾焰。
 */
export class Effects implements FxSink {
  private smoke: ParticlePool
  private add: ParticlePool
  private waves: Shockwaves
  private smokeColor = new THREE.Color(0.72, 0.72, 0.75)
  private dirtColor = new THREE.Color(0.62, 0.52, 0.36)
  private fireColor = new THREE.Color(1, 0.55, 0.15)
  private sparkColor = new THREE.Color(1, 0.85, 0.4)
  private quality: number

  constructor(scene: THREE.Scene, quality: 'low' | 'high' = 'high') {
    this.quality = quality === 'high' ? 1 : 0.45
    this.smoke = new ParticlePool(scene, Math.round(1400 * this.quality), THREE.NormalBlending)
    this.add = new ParticlePool(scene, Math.round(700 * this.quality), THREE.AdditiveBlending)
    this.waves = new Shockwaves(scene)
  }

  tyreSmoke(pos: THREE.Vector3, strength: number) {
    const n = strength > 0.7 ? 2 : 1
    for (let i = 0; i < n; i++) {
      this.smoke.emit({
        x: pos.x + randomRange(-0.2, 0.2),
        y: pos.y + randomRange(0, 0.15),
        z: pos.z + randomRange(-0.2, 0.2),
        vx: randomRange(-0.6, 0.6),
        vy: randomRange(0.6, 1.6),
        vz: randomRange(-0.6, 0.6),
        life: randomRange(0.5, 1.1),
        size0: randomRange(0.4, 0.7) * (0.6 + strength),
        size1: randomRange(2.2, 3.6) * (0.6 + strength),
        color: this.smokeColor,
        alpha: clamp(0.16 + strength * 0.22, 0, 0.45),
        drag: 1.1,
      })
    }
  }

  dust(pos: THREE.Vector3, strength: number) {
    this.smoke.emit({
      x: pos.x + randomRange(-0.3, 0.3),
      y: pos.y + 0.1,
      z: pos.z + randomRange(-0.3, 0.3),
      vx: randomRange(-1.2, 1.2),
      vy: randomRange(0.4, 1.4),
      vz: randomRange(-1.2, 1.2),
      life: randomRange(0.4, 0.9),
      size0: 0.5,
      size1: 2.4,
      color: this.dirtColor,
      alpha: 0.1 + strength * 0.14,
      drag: 1.6,
    })
  }

  /** 氮气尾焰 */
  boostFlame(pos: THREE.Vector3, dir: THREE.Vector3, strength: number) {
    for (let i = 0; i < 2; i++) {
      this.add.emit({
        x: pos.x + randomRange(-0.1, 0.1),
        y: pos.y + randomRange(-0.1, 0.1),
        z: pos.z + randomRange(-0.1, 0.1),
        vx: dir.x * randomRange(3, 8) + randomRange(-0.6, 0.6),
        vy: randomRange(-0.2, 0.6),
        vz: dir.z * randomRange(3, 8) + randomRange(-0.6, 0.6),
        life: randomRange(0.14, 0.3),
        size0: 0.55 * strength,
        size1: 0.05,
        color: i === 0 ? this.fireColor : new THREE.Color(0.35, 0.75, 1),
        alpha: 0.85,
        drag: 3,
      })
    }
  }

  sparks(pos: THREE.Vector3, strength: number) {
    const n = Math.round(6 + strength * 14 * this.quality)
    for (let i = 0; i < n; i++) {
      this.add.emit({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: randomRange(-6, 6) * (0.4 + strength),
        vy: randomRange(1, 7) * (0.4 + strength),
        vz: randomRange(-6, 6) * (0.4 + strength),
        life: randomRange(0.25, 0.7),
        size0: 0.3,
        size1: 0.02,
        color: this.sparkColor,
        alpha: 0.95,
        gravity: 14,
        drag: 0.8,
      })
    }
  }

  explosion(pos: THREE.Vector3, scale = 1) {
    this.waves.spawn(pos, scale)
    const n = Math.round(60 * this.quality)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const e = Math.random() * Math.PI * 0.5
      const sp = randomRange(3, 16) * scale
      this.add.emit({
        x: pos.x,
        y: pos.y + 0.4,
        z: pos.z,
        vx: Math.cos(a) * Math.cos(e) * sp,
        vy: Math.sin(e) * sp * 1.2,
        vz: Math.sin(a) * Math.cos(e) * sp,
        life: randomRange(0.3, 0.9),
        size0: randomRange(0.8, 1.8) * scale,
        size1: 0.1,
        color: i % 3 === 0 ? new THREE.Color(1, 0.95, 0.7) : this.fireColor,
        alpha: 0.95,
        gravity: 9,
        drag: 1.4,
      })
    }
    const ns = Math.round(36 * this.quality)
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * Math.PI * 2
      this.smoke.emit({
        x: pos.x,
        y: pos.y + 0.5,
        z: pos.z,
        vx: Math.cos(a) * randomRange(1, 7),
        vy: randomRange(1, 5),
        vz: Math.sin(a) * randomRange(1, 7),
        life: randomRange(0.9, 2.0),
        size0: 1.2 * scale,
        size1: 5 * scale,
        color: new THREE.Color(0.25, 0.24, 0.25),
        alpha: 0.4,
        drag: 1.1,
      })
    }
  }

  update(dt: number) {
    this.smoke.update(dt)
    this.add.update(dt)
    this.waves.update(dt)
  }

  clear() {
    this.smoke.clear()
    this.add.clear()
  }
}
