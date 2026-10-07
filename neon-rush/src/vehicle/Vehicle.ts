import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { PhysicsWorld, SurfaceBody } from '../physics/PhysicsWorld'
import { createCarMesh, createWheelMesh, CarMesh } from './CarMesh'
import { clamp, damp } from '../utils/math'
import type { VehicleInput } from '../core/Input'


export interface VehicleTuning {
  mass: number
  /** 单个驱动轮最大推力 (N) */
  engineForce: number
  nitroForce: number
  reverseForce: number
  brakeForce: number
  handbrakeForce: number
  /** 最大转向角 (rad) */
  maxSteer: number
  /** 极速 (m/s) */
  topSpeed: number
  suspensionStiffness: number
  suspensionRestLength: number
  dampingRelaxation: number
  dampingCompression: number
  frictionSlip: number
  grassFriction: number
  rollInfluence: number
  maxSuspensionTravel: number
  maxSuspensionForce: number
  /** 下压力系数: F = k * v^2 */
  downforce: number
  nitroCapacity: number
  nitroDrain: number
  nitroRegen: number
}

export const defaultTuning: VehicleTuning = {
  mass: 240,
  engineForce: 3400,
  nitroForce: 2600,
  reverseForce: 1400,
  brakeForce: 55,
  handbrakeForce: 220,
  maxSteer: 0.55,
  topSpeed: 66,
  suspensionStiffness: 36,
  suspensionRestLength: 0.34,
  dampingRelaxation: 2.6,
  dampingCompression: 4.6,
  frictionSlip: 3.4,
  grassFriction: 1.5,
  rollInfluence: 0.03,
  maxSuspensionTravel: 0.34,
  maxSuspensionForce: 90000,
  downforce: 2.4,
  nitroCapacity: 100,
  nitroDrain: 34,
  nitroRegen: 7,
}

export interface FxSink {
  tyreSmoke?(pos: THREE.Vector3, strength: number): void
  dust?(pos: THREE.Vector3, strength: number): void
  sparks?(pos: THREE.Vector3, strength: number): void
  explosion?(pos: THREE.Vector3, scale: number): void
  boostFlame?(pos: THREE.Vector3, dir: THREE.Vector3, strength: number): void
}

const CHASSIS = { x: 0.92, y: 0.42, z: 2.05 }
const WHEEL_X = 0.86
const WHEEL_Z_F = 1.35
const WHEEL_Z_R = -1.38
const CONNECTION_Y = -0.06
const WHEEL_RADIUS = 0.38

/** 由调试面板 / 天气控制的全局抓地力系数 */
export const grip = { weather: 1, global: 1 }

const tmpCannonVecA = new CANNON.Vec3()
const tmpCannonVecB = new CANNON.Vec3()

export class Vehicle {
  readonly body: CANNON.Body
  readonly raycast: CANNON.RaycastVehicle
  readonly mesh: CarMesh
  readonly wheelMeshes: THREE.Group[] = []
  tuning: VehicleTuning

  name: string
  isPlayer = false
  color: number

  /** 氮气 */
  nitroAmount: number
  nitroActive = false
  /** 血量（战斗模式） */
  health = 100
  maxHealth = 100
  alive = true

  /** 本帧状态 */
  speedKmh = 0
  forwardSpeed = 0
  groundedWheels = 0
  onGrass = false
  airborne = false
  slip = 0

  /** 外部回调 */
  onImpact?: (strength: number, other: CANNON.Body | null, point: THREE.Vector3) => void
  fx?: FxSink

  private steerCurrent = 0
  private tmpVec = new THREE.Vector3()
  private tmpFwd = new THREE.Vector3()
  private tmpQuat = new THREE.Quaternion()
  private flipTimer = 0
  private collideCooldown = 0
  private scene: THREE.Scene
  private physics: PhysicsWorld

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    position: THREE.Vector3,
    heading: number,
    color = 0x37f5d8,
    tuning?: VehicleTuning,
    name = 'car'
  ) {
    this.scene = scene
    this.physics = physics
    this.color = color
    this.name = name
    // 直接共享调试面板所引用的 tuning 对象，支持实时调参
    this.tuning = tuning ?? { ...defaultTuning }
    this.nitroAmount = this.tuning.nitroCapacity

    // ---------- 物理底盘 ----------
    const shape = new CANNON.Box(new CANNON.Vec3(CHASSIS.x, CHASSIS.y, CHASSIS.z))
    this.body = new CANNON.Body({
      mass: this.tuning.mass,
      material: physics.materials.car,
      position: new CANNON.Vec3(position.x, position.y, position.z),
    })
    this.body.addShape(shape)
    this.body.angularDamping = 0.3
    this.body.linearDamping = 0.02
    this.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading)
    this.body.allowSleep = false

    // ---------- RaycastVehicle ----------
    this.raycast = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    })

    const base = {
      radius: WHEEL_RADIUS,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: this.tuning.suspensionStiffness,
      suspensionRestLength: this.tuning.suspensionRestLength,
      frictionSlip: this.tuning.frictionSlip,
      dampingRelaxation: this.tuning.dampingRelaxation,
      dampingCompression: this.tuning.dampingCompression,
      maxSuspensionForce: this.tuning.maxSuspensionForce,
      rollInfluence: this.tuning.rollInfluence,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(),
      maxSuspensionTravel: this.tuning.maxSuspensionTravel,
      customSlidingRotationalSpeed: -32,
      useCustomSlidingRotationalSpeed: true,
    }

    // 0: 左前 1: 右前 2: 左后 3: 右后
    const positions: [number, number][] = [
      [WHEEL_X, WHEEL_Z_F],
      [-WHEEL_X, WHEEL_Z_F],
      [WHEEL_X, WHEEL_Z_R],
      [-WHEEL_X, WHEEL_Z_R],
    ]
    for (const [x, z] of positions) {
      this.raycast.addWheel({
        ...base,
        chassisConnectionPointLocal: new CANNON.Vec3(x, CONNECTION_Y, z),
      })
    }
    this.raycast.addToWorld(physics.world)

    // ---------- 视觉 ----------
    this.mesh = createCarMesh(color, name === 'player')
    this.mesh.group.position.copy(position)
    this.mesh.group.rotation.y = heading
    scene.add(this.mesh.group)

    for (let i = 0; i < 4; i++) {
      const w = createWheelMesh()
      scene.add(w)
      this.wheelMeshes.push(w)
    }

    this.body.addEventListener('collide', this.handleCollide)
  }

  // ------------------------------------------------------------------
  private handleCollide = (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => {
    if (this.collideCooldown > 0) return
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
    if (v < 3) return
    this.collideCooldown = 0.12
    const strength = clamp(v / 26, 0, 1)
    const p = this.body.position
    this.onImpact?.(strength, e.body, new THREE.Vector3(p.x, p.y, p.z))
    if (strength > 0.12) this.fx?.sparks?.(this.tmpVec.set(p.x, p.y, p.z), strength)
  }

  get position(): THREE.Vector3 {
    const p = this.body.position
    return this.tmpVec.set(p.x, p.y, p.z)
  }

  get quaternion(): THREE.Quaternion {
    const q = this.body.quaternion
    return this.tmpQuat.set(q.x, q.y, q.z, q.w)
  }

  /** 车辆局部轴在世界空间的方向（等同于 RaycastVehicle.getVehicleAxisWorld） */
  private axisWorld(index: number, out: CANNON.Vec3): CANNON.Vec3 {
    out.set(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0)
    this.body.quaternion.vmult(out, out)
    return out
  }

  forwardVector(out = new THREE.Vector3()): THREE.Vector3 {
    const v = this.axisWorld(2, tmpCannonVecA)
    return out.set(v.x, v.y, v.z)
  }

  get upDot(): number {
    return this.axisWorld(1, tmpCannonVecA).y
  }

  // ------------------------------------------------------------------
  update(dt: number, input: VehicleInput) {
    if (!this.alive) {
      this.syncMeshes()
      return
    }
    this.collideCooldown = Math.max(0, this.collideCooldown - dt)
    const t = this.tuning
    const vel = this.body.velocity

    this.forwardVector(this.tmpFwd)
    this.forwardSpeed = vel.x * this.tmpFwd.x + vel.y * this.tmpFwd.y + vel.z * this.tmpFwd.z
    this.speedKmh = Math.abs(this.forwardSpeed) * 3.6
    this.groundedWheels = this.raycast.numWheelsOnGround
    this.airborne = this.groundedWheels === 0

    // ===== 转向（高速收窄舵角） =====
    const speedFactor = 1 - clamp(Math.abs(this.forwardSpeed) / 45, 0, 1) * 0.55
    const maxSteer = t.maxSteer * (0.38 + 0.62 * speedFactor)
    const steerTarget = input.steer * maxSteer
    this.steerCurrent = damp(this.steerCurrent, steerTarget, 11, dt)
    // 正 steering = 左转（cannon 约定：绕 up 正向旋转指向 +X，即车辆左侧）
    this.raycast.setSteeringValue(-this.steerCurrent, 0)
    this.raycast.setSteeringValue(-this.steerCurrent, 1)

    // ===== 氮气 =====
    const wantNitro = input.nitro && this.nitroAmount > 1 && !this.airborne
    this.nitroActive = wantNitro
    if (wantNitro) {
      this.nitroAmount = Math.max(0, this.nitroAmount - t.nitroDrain * dt)
    } else {
      this.nitroAmount = Math.min(t.nitroCapacity, this.nitroAmount + t.nitroRegen * dt)
    }

    // ===== 驱动 / 刹车 =====
    const topSpeed = t.topSpeed * (this.nitroActive ? 1.24 : 1)
    let engine = 0
    let brake = 0

    if (input.throttle > 0.01) {
      const ratio = clamp(Math.abs(this.forwardSpeed) / topSpeed, 0, 1)
      const falloff = Math.max(0, 1 - ratio * ratio)
      engine = -t.engineForce * input.throttle * falloff // 负 = 前进
      if (this.nitroActive) engine -= t.nitroForce * falloff
    } else if (this.groundedWheels > 0) {
      brake = 2.2 // 引擎制动
    }

    if (input.brake > 0.01) {
      if (this.forwardSpeed > 0.8) {
        brake += t.brakeForce * input.brake
        engine = 0
      } else {
        // 倒车
        engine = t.reverseForce * input.brake
      }
    }

    // 手刹：后轮锁死 + 降低后轮抓地 -> 漂移
    let rearSlip = 1
    if (input.handbrake) {
      brake = 0
      this.raycast.setBrake(t.handbrakeForce, 2)
      this.raycast.setBrake(t.handbrakeForce, 3)
      rearSlip = 0.42
    }

    for (let i = 0; i < 4; i++) {
      const isFront = i < 2
      this.raycast.applyEngineForce(engine * (isFront ? 0.4 : 1), i)
      if (!input.handbrake) this.raycast.setBrake(brake * (isFront ? 1 : 0.75), i)
    }

    // ===== 轮胎抓地力 / 路面检测 =====
    let grassHits = 0
    let slipSum = 0
    this.onGrass = false
    for (let i = 0; i < 4; i++) {
      const w = this.raycast.wheelInfos[i]
      const hit = w.raycastResult.body as SurfaceBody | null
      const surface: string = hit?.surfaceType ?? 'ground'
      const isGrass = surface === 'grass' || surface === 'ground'
      if (isGrass && w.isInContact) grassHits++

      let slip = t.frictionSlip * grip.weather * grip.global
      if (isGrass) slip = Math.min(slip, t.grassFriction * grip.weather)
      if (i > 1) slip *= rearSlip
      w.frictionSlip = slip

      // 打滑量：skidInfo < 1 表示超出摩擦圆
      slipSum += clamp(1 - (w.skidInfo ?? 1), 0, 1)
    }
    this.slip = slipSum / 4
    this.onGrass = grassHits >= 3 && this.groundedWheels > 0

    // 草地额外阻力
    if (this.onGrass && this.groundedWheels > 0) {
      const drag = this.forwardSpeed * 12
      this.body.applyForce(new CANNON.Vec3(-this.tmpFwd.x * drag, 0, -this.tmpFwd.z * drag))
    }

    // ===== 下压力 =====
    if (this.groundedWheels > 0) {
      const df = t.downforce * this.forwardSpeed * this.forwardSpeed
      this.body.applyForce(new CANNON.Vec3(0, -df, 0))
    }

    // ===== 空中姿态微调 =====
    if (this.airborne) {
      const pitch = (input.throttle - input.brake) * 1.6
      const yaw = -input.steer * 1.1
      this.body.angularVelocity.x += pitch * dt
      this.body.angularVelocity.y += yaw * dt
      this.body.angularVelocity.x = clamp(this.body.angularVelocity.x, -3, 3)
    }

    // ===== 翻车自动扶正 =====
    if (this.upDot < 0.15 && this.groundedWheels > 0) {
      this.flipTimer += dt
      if (this.flipTimer > 2.2) {
        this.flipTimer = 0
        this.respawnUpright()
      }
    } else {
      this.flipTimer = 0
    }

    // ===== 特效发射 =====
    this.emitEffects(dt, input)
    this.lastInput = input
  }

  private lastInput: VehicleInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    nitro: false,
  }

  /** 物理步进之后调用：同步网格与灯光 */
  postStep() {
    this.syncMeshes()
    this.mesh.setBrake(this.lastInput.brake > 0.01 ? 1 : 0)
    this.mesh.setBoost(this.nitroActive ? 0.55 + Math.random() * 0.45 : 0)
  }

  private emitEffects(dt: number, input: VehicleInput) {
    if (!this.fx || dt <= 0) return
    const speed = Math.abs(this.forwardSpeed)
    for (let i = 0; i < 4; i++) {
      const w = this.raycast.wheelInfos[i]
      if (!w.isInContact) continue
      const hp = w.raycastResult.hitPointWorld
      const p = this.tmpVec.set(hp.x, hp.y + 0.05, hp.z)
      const isRear = i > 1
      const handbrakeSlide = input.handbrake && speed > 5
      const burnout = isRear && input.throttle > 0.5 && this.slip > 0.35 && speed < 22
      const slide = this.slip > 0.28 && speed > 6

      const surface = (w.raycastResult.body as SurfaceBody | null)?.surfaceType
      if (surface === 'grass' || surface === 'ground') {
        if (speed > 4) this.fx.dust?.(p, clamp(speed / 30, 0.2, 1))
      }
      if (slide || handbrakeSlide || burnout) {
        this.fx.tyreSmoke?.(p, clamp(this.slip + (handbrakeSlide ? 0.4 : 0), 0.2, 1))
      }
    }
  }

  private syncMeshes() {
    const p = this.body.position
    const q = this.body.quaternion
    this.mesh.group.position.set(p.x, p.y, p.z)
    this.mesh.group.quaternion.set(q.x, q.y, q.z, q.w)
    for (let i = 0; i < 4; i++) {
      this.raycast.updateWheelTransform(i)
      const wt = this.raycast.wheelInfos[i].worldTransform
      const m = this.wheelMeshes[i]
      m.position.set(wt.position.x, wt.position.y, wt.position.z)
      m.quaternion.set(wt.quaternion.x, wt.quaternion.y, wt.quaternion.z, wt.quaternion.w)
    }
  }

  /** 原地扶正（保留位置） */
  respawnUpright() {
    const p = this.body.position
    const fwd = this.axisWorld(2, tmpCannonVecB)
    const heading = Math.atan2(fwd.x, fwd.z)
    this.reset(new THREE.Vector3(p.x, p.y + 1.2, p.z), heading)
  }

  reset(position: THREE.Vector3, heading: number) {
    this.body.position.set(position.x, position.y, position.z)
    this.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading)
    this.body.velocity.setZero()
    this.body.angularVelocity.setZero()
    this.body.force.setZero()
    this.body.torque.setZero()
    for (let i = 0; i < 4; i++) {
      const w = this.raycast.wheelInfos[i]
      w.suspensionLength = this.tuning.suspensionRestLength
      w.suspensionRelativeVelocity = 0
      w.deltaRotation = 0
      w.rotation = 0
      w.steering = 0
      this.raycast.applyEngineForce(0, i)
      this.raycast.setBrake(0, i)
      this.raycast.updateWheelTransform(i)
    }
    this.steerCurrent = 0
    this.syncMeshes()
  }

  applyDamage(amount: number) {
    if (!this.alive) return
    this.health = Math.max(0, this.health - amount)
    if (this.health <= 0) this.kill()
  }

  kill() {
    if (!this.alive) return
    this.alive = false
    this.health = 0
    this.fx?.explosion?.(this.position.clone(), 1.6)
    this.mesh.group.visible = false
    for (const w of this.wheelMeshes) w.visible = false
    for (let i = 0; i < 4; i++) {
      this.raycast.applyEngineForce(0, i)
      this.raycast.setBrake(1000, i)
    }
  }

  revive(position: THREE.Vector3, heading: number) {
    this.alive = true
    this.health = this.maxHealth
    this.mesh.group.visible = true
    for (const w of this.wheelMeshes) w.visible = true
    this.reset(position, heading)
  }

  setColor(hex: number) {
    this.color = hex
    this.mesh.setColor(hex)
  }

  setGhostMode(on: boolean) {
    this.mesh.setGhost(on)
  }

  /** 假想档位（用于 HUD 与音效） */
  getGear(): number {
    const s = Math.abs(this.forwardSpeed)
    if (s < 0.6) return 0
    return Math.min(6, 1 + Math.floor(s / (this.tuning.topSpeed / 6)))
  }

  getRpm01(): number {
    const gear = this.getGear()
    if (gear === 0) return 0.12 + (this.inputThrottleCache ?? 0) * 0.25
    const span = this.tuning.topSpeed / 6
    const s = Math.abs(this.forwardSpeed)
    return clamp(0.25 + ((s - (gear - 1) * span) / span) * 0.75, 0.15, 1)
  }

  private inputThrottleCache = 0
  setThrottleCache(v: number) {
    this.inputThrottleCache = v
  }

  dispose() {
    this.body.removeEventListener('collide', this.handleCollide)
    this.raycast.removeFromWorld(this.physics.world)
    this.scene.remove(this.mesh.group)
    this.mesh.dispose()
    for (const w of this.wheelMeshes) {
      this.scene.remove(w)
      w.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
    }
  }
}
