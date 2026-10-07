import * as THREE from 'three'
import { clamp, damp, lerp } from '../utils/math'
import type { Vehicle } from '../vehicle/Vehicle'

export type CameraMode = 'chase' | 'hood' | 'far' | 'top'

const MODES: CameraMode[] = ['chase', 'hood', 'far', 'top']

export interface CameraTuning {
  distance: number
  height: number
  lookAhead: number
  damping: number
  fov: number
  speedFov: number
}

export class CameraRig {
  mode: CameraMode = 'chase'
  tuning: CameraTuning = {
    distance: 8.4,
    height: 3.3,
    lookAhead: 9,
    damping: 6,
    fov: 62,
    speedFov: 16,
  }

  private camera: THREE.PerspectiveCamera
  private currentPos = new THREE.Vector3()
  private currentLook = new THREE.Vector3()
  private desiredPos = new THREE.Vector3()
  private desiredLook = new THREE.Vector3()
  private shake = 0
  private shakeOffset = new THREE.Vector3()
  private forward = new THREE.Vector3()
  private initialized = false

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera
  }

  cycle(): CameraMode {
    const i = MODES.indexOf(this.mode)
    this.mode = MODES[(i + 1) % MODES.length]
    return this.mode
  }

  setMode(m: CameraMode) {
    this.mode = m
  }

  addShake(amount: number) {
    this.shake = Math.min(1.4, this.shake + amount)
  }

  /** 立即贴到目标位置（切换模式/重开时用） */
  snap(vehicle: Vehicle) {
    this.computeDesired(vehicle, 1)
    this.currentPos.copy(this.desiredPos)
    this.currentLook.copy(this.desiredLook)
    this.initialized = true
  }

  private computeDesired(v: Vehicle, dt: number) {
    const p = v.mesh.group.position
    v.forwardVector(this.forward)
    this.forward.y = 0
    if (this.forward.lengthSq() < 0.001) this.forward.set(0, 0, 1)
    this.forward.normalize()

    const speed01 = clamp(Math.abs(v.forwardSpeed) / 60, 0, 1)
    const t = this.tuning

    switch (this.mode) {
      case 'hood': {
        this.desiredPos
          .copy(p)
          .addScaledVector(this.forward, 0.55)
          .add(new THREE.Vector3(0, 1.05, 0))
        this.desiredLook.copy(p).addScaledVector(this.forward, 40).add(new THREE.Vector3(0, 1.0, 0))
        break
      }
      case 'top': {
        this.desiredPos.copy(p).add(new THREE.Vector3(0, 34, 0)).addScaledVector(this.forward, -8)
        this.desiredLook.copy(p)
        break
      }
      case 'far': {
        const d = t.distance + 12 + speed01 * 5
        this.desiredPos
          .copy(p)
          .addScaledVector(this.forward, -d)
          .add(new THREE.Vector3(0, t.height + 3.2, 0))
        this.desiredLook.copy(p).addScaledVector(this.forward, t.lookAhead * 1.4)
        break
      }
      default: {
        const d = t.distance + speed01 * 2.2 + (v.nitroActive ? 1.6 : 0)
        const h = t.height + speed01 * 0.5
        this.desiredPos
          .copy(p)
          .addScaledVector(this.forward, -d)
          .add(new THREE.Vector3(0, h, 0))
        this.desiredLook
          .copy(p)
          .addScaledVector(this.forward, t.lookAhead)
          .add(new THREE.Vector3(0, 0.9, 0))
        break
      }
    }

    // 防止穿地
    const minY = p.y + 0.9
    if (this.desiredPos.y < minY && this.mode !== 'top') this.desiredPos.y = minY
    void dt
  }

  update(dt: number, vehicle: Vehicle) {
    if (!this.initialized) this.snap(vehicle)
    this.computeDesired(vehicle, dt)

    const damp =
      this.mode === 'hood' ? 18 : this.mode === 'chase' ? this.tuning.damping : this.tuning.damping * 0.7
    const k = 1 - Math.exp(-damp * dt)
    this.currentPos.lerp(this.desiredPos, k)
    this.currentLook.lerp(this.desiredLook, Math.min(1, k * 1.4))

    // 抖动
    this.shake = Math.max(0, this.shake - dt * 2.2)
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.9
      this.shakeOffset.set(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s
      )
    } else {
      this.shakeOffset.set(0, 0, 0)
    }

    this.camera.position.copy(this.currentPos).add(this.shakeOffset)
    this.camera.lookAt(this.currentLook)
    if (this.mode === 'top') this.camera.rotation.z = 0

    // 速度感 FOV
    const speed01 = clamp(Math.abs(vehicle.forwardSpeed) / 65, 0, 1)
    const targetFov =
      this.tuning.fov +
      speed01 * this.tuning.speedFov +
      (vehicle.nitroActive ? 8 : 0) +
      (this.mode === 'hood' ? 10 : 0)
    this.camera.fov = lerp(this.camera.fov, targetFov, 1 - Math.exp(-5 * dt))
    this.camera.updateProjectionMatrix()
  }

  /** 开场环绕镜头 */
  orbitIntro(dt: number, vehicle: Vehicle, progress: number) {
    const p = vehicle.mesh.group.position
    const angle = progress * Math.PI * 2
    const r = 14
    this.camera.position.set(p.x + Math.cos(angle) * r, p.y + 4.5, p.z + Math.sin(angle) * r)
    this.camera.lookAt(p.x, p.y + 0.6, p.z)
    this.camera.fov = damp(this.camera.fov, 55, 3, dt)
    this.camera.updateProjectionMatrix()
  }
}
