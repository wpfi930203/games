import { LapRaceMode, type ModeContext, type Racer, type VehicleInputLike } from './Mode'
import { Vehicle } from '../vehicle/Vehicle'
import { Ghost, type GhostSample } from '../vehicle/Ghost'
import type { HudData } from '../ui/HUD'
import type { MinimapDot } from '../ui/Minimap'
import { minimapColorFromHex } from '../ui/Minimap'
import { clamp, formatTime } from '../utils/math'

const STORAGE_KEY = 'neonrush.ghost.v1'

export class TimeTrialMode extends LapRaceMode {
  private ghost: Ghost
  private time = 0
  private bestLap = 0
  private ghostCurve: { s: number; t: number }[] = []
  private loadedBest = 0

  constructor(ctx: ModeContext, laps = 0) {
    super('timetrial', ctx, laps)
    this.ghost = new Ghost(ctx.scene, 0x7af7ff)

    const player = new Vehicle(
      ctx.scene,
      ctx.physics,
      ctx.track.startPosition.clone(),
      ctx.track.startHeading,
      ctx.playerColor,
      ctx.tuning,
      'player'
    )
    player.isPlayer = true
    player.fx = ctx.effects
    player.onImpact = (strength) => {
      if (strength > 0.15) {
        ctx.camera.addShake(strength)
        ctx.vibrate(Math.round(clamp(strength, 0.1, 1) * 70))
        if (strength > 0.25) ctx.audio.impact(strength)
      }
    }
    this.racers.push(this.createRacer(player, 'YOU', ctx.playerColor, true))
    this.loadBest()
  }

  private loadBest() {
    const data = Ghost.load(STORAGE_KEY)
    if (!data) return
    this.loadedBest = data.lapTime
    this.bestLap = data.lapTime
    this.ghost.setData(data.samples as GhostSample[])
    this.ghost.hide()
    this.buildGhostCurve(data.samples as GhostSample[])
  }

  private buildGhostCurve(samples: GhostSample[]) {
    const track = this.ctx.track
    this.ghostCurve = []
    let hint = -1
    for (const s of samples) {
      const proj = track.project(s.p[0], s.p[2], hint)
      hint = proj.index
      this.ghostCurve.push({ s: proj.s, t: s.t })
    }
    this.ghostCurve.sort((a, b) => a.s - b.s)
  }

  /** 幽灵车跑到某个里程时所用的时间 */
  private ghostTimeAt(s: number): number | null {
    const c = this.ghostCurve
    if (c.length < 2) return null
    let lo = 0
    let hi = c.length - 1
    if (s <= c[0].s) return c[0].t
    if (s >= c[hi].s) return null
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (c[mid].s <= s) lo = mid
      else hi = mid
    }
    const a = c[lo]
    const b = c[hi]
    const span = b.s - a.s || 1
    return a.t + ((s - a.s) / span) * (b.t - a.t)
  }

  onEnter() {
    this.ctx.hud.setVisible(true)
    this.ctx.minimap.setTrack(this.ctx.track)
    this.ctx.hud.toast(
      this.loadedBest > 0
        ? `计时赛 · 幽灵车已就绪 (${formatTime(this.loadedBest)})`
        : '计时赛 · 本圈将被记录为幽灵车',
      3
    )
  }

  onExit() {
    for (const r of this.racers) r.vehicle.dispose()
    this.racers = []
    this.ghost.mesh.dispose()
    this.ctx.scene.remove(this.ghost.group)
  }

  protected onLapComplete(r: Racer) {
    const lapTime = this.time - r.lapStart
    r.lapStart = this.time
    if (lapTime < 3) return
    r.lastLap = lapTime

    const isBest = this.bestLap === 0 || lapTime < this.bestLap
    if (isBest) {
      const samples = this.ghost.stopRecording()
      this.bestLap = lapTime
      if (samples.length > 10) {
        this.ghost.save(STORAGE_KEY, lapTime)
        this.ghost.setData(samples)
        this.buildGhostCurve(samples)
        this.loadedBest = lapTime
        this.ctx.hud.toast(`🏁 新纪录 ${lapTime.toFixed(2)}s · 幽灵车已更新`, 3)
      }
    } else {
      this.ghost.stopRecording()
      this.ctx.hud.toast(`圈速 ${lapTime.toFixed(2)}s · 最佳 ${this.bestLap.toFixed(2)}s`, 2.4)
    }

    this.ghost.reset()
    this.ghost.show()
    this.ghost.startRecording()
    this.ctx.audio.beep(isBest ? 920 : 640, 0.18, 'triangle')
  }

  update(dt: number, playerInput: VehicleInputLike) {
    const started = this.tickCountdown(dt)
    if (started) this.time += dt
    this.raceTime = this.time

    const me = this.racers[0]
    if (started && !this.ghost.isRecording) this.ghost.startRecordingOnce()

    const input = started
      ? playerInput
      : { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }
    me.vehicle.setThrottleCache(input.throttle)
    me.vehicle.update(dt, input)

    if (started) {
      this.ghost.record(dt, me.vehicle.mesh.group.position, me.vehicle.mesh.group.quaternion)
    }
    this.ghost.update(dt)

    this.updateProgress(dt)
    this.updatePlaces()
  }

  respawnPlayer() {
    const r = this.racers[0]
    const pos = this.ctx.track.resetPointAtS(r.s - 6, 0)
    r.vehicle.reset(pos, this.ctx.track.headingAtS(r.s - 6))
    this.ghost.reset()
  }

  hudData(): HudData {
    const me = this.racers[0]
    const lapTime = this.time - me.lapStart
    const g = this.ghostTimeAt(me.s)
    return {
      speed: me.vehicle.speedKmh,
      gear: me.vehicle.getGear(),
      nitro01: me.vehicle.nitroAmount / me.vehicle.tuning.nitroCapacity,
      lap: me.laps + 1,
      totalLaps: 0,
      time: lapTime,
      best: this.bestLap,
      delta: g === null ? null : lapTime - g,
      position: 1,
      total: 1,
      health01: 1,
      showHealth: false,
      scoreText: '',
      standings: [
        { name: '本圈', value: formatTime(lapTime), me: true },
        { name: '最佳', value: this.bestLap ? formatTime(this.bestLap) : '--', me: false },
        { name: '幽灵', value: g === null ? '--' : formatTime(g), me: false },
      ],
    }
  }

  minimapDots(): MinimapDot[] {
    const me = this.racers[0]
    const p = me.vehicle.mesh.group.position
    const dots: MinimapDot[] = [
      { x: p.x, z: p.z, color: minimapColorFromHex(me.color), me: true },
    ]
    if (this.ghost.visible) {
      dots.push({
        x: this.ghost.group.position.x,
        z: this.ghost.group.position.z,
        color: '#7af7ff',
        me: false,
        ghost: true,
      })
    }
    return dots
  }
}
