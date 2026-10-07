import * as THREE from 'three'
import { createCarMesh, type CarMesh } from './CarMesh'
import { clamp } from '../utils/math'

interface Sample {
  t: number
  p: [number, number, number]
  q: [number, number, number, number]
}

const RATE = 1 / 20 // 20Hz 采样

/** 幽灵车：录制 / 回放玩家最佳圈 */
export class Ghost {
  mesh: CarMesh
  group: THREE.Group
  private samples: Sample[] = []
  private time = 0
  private playT = 0
  private recording = false
  private acc = 0
  private lastIndex = 0
  visible = false

  constructor(scene: THREE.Scene, color = 0x7af7ff) {
    this.mesh = createCarMesh(color, false)
    this.mesh.setGhost(true)
    this.group = this.mesh.group
    this.group.visible = false
    scene.add(this.group)
    // 简易车轮（幽灵车不需要物理）
    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 10)
    wheelGeo.rotateZ(Math.PI / 2)
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x222228,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
    const spots: [number, number, number][] = [
      [0.86, -0.3, 1.35],
      [-0.86, -0.3, 1.35],
      [0.86, -0.3, -1.38],
      [-0.86, -0.3, -1.38],
    ]
    for (const [x, y, z] of spots) {
      const w = new THREE.Mesh(wheelGeo, wheelMat)
      w.position.set(x, y, z)
      this.group.add(w)
    }
  }

  get hasData(): boolean {
    return this.samples.length > 2
  }

  get duration(): number {
    return this.samples.length ? this.samples[this.samples.length - 1].t : 0
  }

  get isRecording(): boolean {
    return this.recording
  }

  startRecording() {
    this.samples = []
    this.time = 0
    this.recording = true
    this.acc = RATE
  }

  /** 只在未录制时开始 */
  startRecordingOnce() {
    if (!this.recording) this.startRecording()
  }

  stopRecording(): Sample[] {
    this.recording = false
    return this.samples
  }

  record(dt: number, position: THREE.Vector3, quaternion: THREE.Quaternion) {
    if (!this.recording) return
    this.time += dt
    this.acc += dt
    if (this.acc < RATE) return
    this.acc = 0
    this.samples.push({
      t: this.time,
      p: [position.x, position.y, position.z],
      q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    })
  }

  setData(samples: Sample[], loop = true) {
    this.samples = samples ?? []
    this.playT = 0
    this.lastIndex = 0
    this.visible = this.hasData
    this.group.visible = this.hasData
    void loop
  }

  hide() {
    this.visible = false
    this.group.visible = false
  }

  show() {
    this.visible = this.hasData
    this.group.visible = this.hasData
  }

  reset() {
    this.playT = 0
    this.lastIndex = 0
  }

  update(dt: number) {
    if (!this.visible || !this.hasData) return
    this.playT += dt
    const total = this.duration
    if (this.playT > total) this.playT -= total

    const t = this.playT
    // 从上次索引继续向后查找（近似 O(1)）
    let i = this.lastIndex
    if (this.samples[i].t > t) i = 0
    while (i < this.samples.length - 2 && this.samples[i + 1].t < t) i++
    this.lastIndex = i

    const a = this.samples[i]
    const b = this.samples[Math.min(i + 1, this.samples.length - 1)]
    const span = b.t - a.t || 1e-4
    const k = clamp((t - a.t) / span, 0, 1)

    this.group.position.set(
      a.p[0] + (b.p[0] - a.p[0]) * k,
      a.p[1] + (b.p[1] - a.p[1]) * k,
      a.p[2] + (b.p[2] - a.p[2]) * k
    )
    const qa = new THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3])
    const qb = new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3])
    qa.slerp(qb, k)
    this.group.quaternion.copy(qa)
  }

  // ---------- 持久化 ----------
  save(key: string, lapTime: number) {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ lapTime, samples: this.samples })
      )
    } catch {
      /* 忽略存储失败 */
    }
  }

  static load(key: string): { lapTime: number; samples: Sample[] } | null {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const data = JSON.parse(raw)
      if (!data || !Array.isArray(data.samples) || data.samples.length < 2) return null
      return data
    } catch {
      return null
    }
  }
}

export type { Sample as GhostSample }
