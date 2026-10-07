import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import type { Track } from '../world/Track'
import type { Effects } from '../fx/Effects'
import type { Environment } from '../world/Environment'
import type { HUD, HudData } from '../ui/HUD'
import type { Minimap, MinimapDot } from '../ui/Minimap'
import type { AudioManager } from '../core/AudioManager'
import type { InputManager } from '../core/Input'
import type { CameraRig } from '../camera/CameraRig'
import type { Vehicle, VehicleTuning } from '../vehicle/Vehicle'
import type { VehicleInput } from '../core/Input'
import type { AIDriver } from '../vehicle/AIDriver'

export interface ModeContext {
  scene: THREE.Scene
  physics: PhysicsWorld
  track: Track
  effects: Effects
  environment: Environment
  hud: HUD
  minimap: Minimap
  audio: AudioManager
  input: InputManager
  camera: CameraRig
  quality: 'low' | 'high'
  playerColor: number
  vibrate(pattern: number | number[]): void
  finish(title: string, rows: string[]): void
  tuning: VehicleTuning
}

export abstract class GameMode {
  readonly id: string
  protected ctx: ModeContext
  finished = false
  /** 倒计时剩余秒数（<=0 表示已开始） */
  countdown = 3.2
  raceTime = 0

  constructor(id: string, ctx: ModeContext) {
    this.id = id
    this.ctx = ctx
  }

  abstract player: Vehicle
  abstract vehicles: Vehicle[]
  abstract ais: AIDriver[]

  abstract onEnter(): void
  abstract onExit(): void
  abstract update(dt: number, playerInput: VehicleInputLike): void
  abstract hudData(): HudData
  abstract minimapDots(): MinimapDot[]

  /** 复位玩家车辆 */
  abstract respawnPlayer(): void

  /** 倒计时，返回是否已经起跑 */
  protected tickCountdown(dt: number): boolean {
    if (this.countdown <= 0) return true
    this.countdown -= dt
    const n = Math.ceil(this.countdown - 0.2)
    if (n !== this.lastCountdownTick) {
      this.lastCountdownTick = n
      if (n >= 1 && n <= 3) {
        this.ctx.hud.showCenter(String(n))
        this.ctx.audio.beep(520, 0.12, 'square')
      }
    }
    if (this.countdown <= 0) {
      this.ctx.hud.showCenter('GO!')
      this.ctx.audio.beep(880, 0.35, 'square')
      for (const r of this.racers) r.lapStart = 0
      return true
    }
    return false
  }
  protected lastCountdownTick = 99
  protected racers: Racer[] = []

  dispose() {
    this.onExit()
  }
}

export type VehicleInputLike = VehicleInput

// ----------------------------------------------------------------------
//  圈速赛共用逻辑
// ----------------------------------------------------------------------

export interface Racer {
  vehicle: Vehicle
  ai?: AIDriver
  name: string
  color: number
  isPlayer: boolean
  laps: number
  s: number
  total: number
  hint: number
  lapStart: number
  lastLap: number
  best: number
  finished: boolean
  finishTime: number
  wrongWay: boolean
  place: number
  /** 发车点在起跑线后方时，第一次过线不计圈 */
  armLap: boolean
}

export abstract class LapRaceMode extends GameMode {
  racers: Racer[] = []
  totalLaps: number
  protected lastCountdownTick = 99

  constructor(id: string, ctx: ModeContext, totalLaps = 3) {
    super(id, ctx)
    this.totalLaps = totalLaps
  }

  get player(): Vehicle {
    return this.racers.find((r) => r.isPlayer)!.vehicle
  }

  get vehicles(): Vehicle[] {
    return this.racers.map((r) => r.vehicle)
  }

  get ais(): AIDriver[] {
    return this.racers.filter((r) => r.ai).map((r) => r.ai!)
  }

  protected createRacer(
    vehicle: Vehicle,
    name: string,
    color: number,
    isPlayer: boolean,
    ai?: AIDriver
  ): Racer {
    const p = vehicle.mesh.group.position
    const proj = this.ctx.track.project(p.x, p.z)
    return {
      vehicle,
      ai,
      name,
      color,
      isPlayer,
      laps: 0,
      s: proj.s,
      total: proj.s,
      hint: proj.index,
      lapStart: 0,
      lastLap: 0,
      best: 0,
      finished: false,
      finishTime: 0,
      wrongWay: false,
      place: 1,
      // 发车点位于起跑线后方 60m 内时，起步后第一次过线只解锁计圈
      armLap: proj.s > this.ctx.track.length - 60,
    }
  }

  /** 更新每台车的圈速进度 */
  protected updateProgress(_dt: number) {
    const track = this.ctx.track
    for (const r of this.racers) {
      const p = r.vehicle.mesh.group.position
      const proj = track.project(p.x, p.z, r.hint)
      r.hint = proj.index

      const ds = proj.s - r.s
      let lapDone = false
      if (ds < -track.length * 0.5) {
        if (r.armLap) {
          r.armLap = false
        } else {
          r.laps++
          lapDone = true
        }
      } else if (ds > track.length * 0.5) {
        // 倒着过线时回退一圈；但发车后的首次反向穿线（armLap 尚未解除）不能让圈数变成负数
        if (r.laps > 0 && !r.armLap) r.laps--
      }
      r.s = proj.s
      r.total = r.laps * track.length + proj.s

      // 逆行检测
      const fwd = r.vehicle.forwardVector()
      const tangent = track.tangents[proj.index]
      r.wrongWay = fwd.x * tangent.x + fwd.z * tangent.z < -0.25 && r.vehicle.speedKmh > 8

      if (lapDone) this.onLapComplete(r)
    }
  }

  protected onLapComplete(_r: Racer) {
    /* 子类实现 */
  }

  /** 名次（按总里程） */
  protected updatePlaces() {
    const sorted = [...this.racers].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1
      if (a.finished && b.finished) return a.finishTime - b.finishTime
      return b.total - a.total
    })
    sorted.forEach((r, i) => (r.place = i + 1))
    return sorted
  }
}

export const formatGap = (leader: Racer, r: Racer): string => {
  if (r.finished) return r.finishTime.toFixed(2) + 's'
  const d = leader.total - r.total
  const speed = Math.max(28, Math.abs(r.vehicle.forwardSpeed))
  return d <= 0.5 ? 'LEADER' : `+${(d / speed).toFixed(1)}s`
}
