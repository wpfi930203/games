import * as THREE from 'three'
import { clamp, randomRange } from '../utils/math'
import type { Vehicle } from './Vehicle'
import type { VehicleInput } from '../core/Input'
import type { Track } from '../world/Track'

/**
 * 沿赛道中心线行驶的 AI 车手：
 * 前视点跟踪 + 曲率预测刹车 + 简单避让 + 卡死自救。
 */
export class AIDriver {
  vehicle: Vehicle
  skill: number
  /** 走线横向偏移（每台车不同，避免完全重合） */
  private lineOffset: number
  private overtakeBias = 0
  private stuckTimer = 0
  private reverseTimer = 0
  private lastS = 0
  private toTarget = new THREE.Vector3()
  private target = new THREE.Vector3()
  private forward = new THREE.Vector3()
  private right = new THREE.Vector3()

  constructor(
    vehicle: Vehicle,
    private track: Track,
    skill = 0.9
  ) {
    this.vehicle = vehicle
    this.skill = skill
    this.lineOffset = randomRange(-3.2, 3.2)
  }

  update(dt: number, others: Vehicle[], raceStarted: boolean): VehicleInput {
    const v = this.vehicle
    const input: VehicleInput = {
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: false,
      nitro: false,
    }
    if (!raceStarted || !v.alive) return input

    const p = v.mesh.group.position
    const proj = this.track.project(p.x, p.z)
    this.lastS = proj.s

    // ---------- 前视点 ----------
    const speed = Math.abs(v.forwardSpeed)
    const lookAhead = clamp(11 + speed * 0.62, 12, 42)
    const targetS = proj.s + lookAhead
    this.track.pointAtS(targetS, this.target)
    const idx = this.track.indexAtS(targetS)
    this.track.rightAt(idx, this.right)

    // 弯道内切：用前后朝向差估计曲率
    const h0 = this.track.headingAtS(proj.s + 6)
    const h1 = this.track.headingAtS(proj.s + 30)
    const h2 = this.track.headingAtS(proj.s + 55)
    let curv = Math.abs(shortest(h0, h1)) + Math.abs(shortest(h1, h2)) * 0.8
    const bendSign = Math.sign(shortest(h0, h1) || 1)
    const apex = clamp(curv / 0.9, 0, 1)
    const line = this.lineOffset * (1 - apex) - bendSign * apex * 4.2 + this.overtakeBias

    this.target.x += this.right.x * line
    this.target.z += this.right.z * line

    // ---------- 避让 ----------
    this.overtakeBias *= Math.exp(-dt * 1.2)
    for (const o of others) {
      if (o === v || !o.alive) continue
      const op = o.mesh.group.position
      const dx = op.x - p.x
      const dz = op.z - p.z
      const dist = Math.hypot(dx, dz)
      if (dist > 14 || dist < 0.001) continue
      v.forwardVector(this.forward)
      const ahead = (dx * this.forward.x + dz * this.forward.z) / dist
      if (ahead < 0.55) continue
      // 往空的一侧避让
      const side = -(dx * this.right.x + dz * this.right.z) > 0 ? 1 : -1
      this.overtakeBias += side * clamp((14 - dist) / 14, 0, 1) * 5.5
      this.overtakeBias = clamp(this.overtakeBias, -6.5, 6.5)
    }

    // ---------- 转向 ----------
    v.forwardVector(this.forward)
    this.forward.y = 0
    this.forward.normalize()
    this.toTarget.set(this.target.x - p.x, 0, this.target.z - p.z)
    const dist = this.toTarget.length() || 1
    this.toTarget.divideScalar(dist)
    const fwdDot = this.forward.x * this.toTarget.x + this.forward.z * this.toTarget.z
    // 左向量 = up × forward
    const leftDot = this.forward.z * this.toTarget.x - this.forward.x * this.toTarget.z
    const angle = Math.atan2(leftDot, fwdDot)
    input.steer = clamp(-angle * 1.7, -1, 1)

    // 回到赛道中央的强制修正
    if (Math.abs(proj.lateral) > this.track.width * 0.5 - 1.6) {
      input.steer = clamp(input.steer - Math.sign(proj.lateral) * 0.55, -1, 1)
    }

    // ---------- 速度控制 ----------
    const corner = 1 - clamp(curv / 1.25, 0, 1) * 0.72
    let targetSpeed = v.tuning.topSpeed * corner * (0.72 + this.skill * 0.3)
    targetSpeed *= 0.9 + Math.random() * 0.1

    if (speed < targetSpeed - 1) input.throttle = 1
    else if (speed > targetSpeed + 2.5) input.brake = clamp((speed - targetSpeed) / 12, 0, 1)
    else input.throttle = 0.45

    // 大角度打方向时收油
    if (Math.abs(input.steer) > 0.75 && speed > 26) {
      input.throttle *= 0.35
      if (speed > 34) input.brake = Math.max(input.brake, 0.35)
    }

    // 手刹过发夹弯（高技能 AI）
    if (this.skill > 0.9 && curv > 1.0 && speed > 22 && Math.abs(input.steer) > 0.6) {
      input.handbrake = true
    }

    // 直道氮气
    input.nitro = curv < 0.12 && speed > 24 && v.nitroAmount > 45

    // ---------- 卡死自救 ----------
    if (speed < 1.6 && this.reverseTimer <= 0) this.stuckTimer += dt
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 0.6)

    if (this.stuckTimer > 1.6) {
      this.reverseTimer = 1.3
      this.stuckTimer = 0
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt
      input.throttle = 0
      input.brake = 1
      input.steer = -input.steer
      input.nitro = false
    }

    return input
  }

  get progress(): number {
    return this.lastS
  }
}

function shortest(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}
