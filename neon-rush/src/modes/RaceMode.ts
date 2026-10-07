import { LapRaceMode, formatGap, type ModeContext, type Racer, type VehicleInputLike } from './Mode'
import { Vehicle } from '../vehicle/Vehicle'
import { AIDriver } from '../vehicle/AIDriver'
import type { HudData } from '../ui/HUD'
import type { MinimapDot } from '../ui/Minimap'
import { minimapColorFromHex } from '../ui/Minimap'
import { clamp } from '../utils/math'

const AI_COLORS = [0xff5a5a, 0xffc93c, 0x9b7bff, 0x4dd6ff]

export class RaceMode extends LapRaceMode {
  private timeSinceStart = 0

  constructor(ctx: ModeContext, laps = 3, aiCount = 3) {
    super('race', ctx, laps)
    const track = ctx.track

    // ---- 玩家（发车格最后一位） ----
    const playerS = track.length - 34
    const player = new Vehicle(
      ctx.scene,
      ctx.physics,
      track.resetPointAtS(playerS, 0),
      track.headingAtS(playerS),
      ctx.playerColor,
      ctx.tuning,
      'player'
    )
    player.isPlayer = true
    this.racers.push(this.createRacer(player, 'YOU', ctx.playerColor, true))

    // ---- AI（发车格前排） ----
    for (let i = 0; i < aiCount; i++) {
      const s = track.length - 10 - i * 8
      const lateral = i % 2 === 0 ? -3.5 : 3.5
      const color = AI_COLORS[i % AI_COLORS.length]
      const v = new Vehicle(
        ctx.scene,
        ctx.physics,
        track.resetPointAtS(s, lateral),
        track.headingAtS(s),
        color,
        ctx.tuning,
        `AI ${i + 1}`
      )
      const ai = new AIDriver(v, track, 0.86 + i * 0.045)
      this.racers.push(this.createRacer(v, `AI ${i + 1}`, color, false, ai))
    }

    for (const r of this.racers) {
      r.vehicle.fx = ctx.effects
      r.vehicle.onImpact = (strength) => this.onImpact(r, strength)
    }
    this.player.onImpact = (strength) => this.onImpact(this.racers[0], strength)
  }

  private onImpact(r: Racer, strength: number) {
    if (strength < 0.15) return
    if (r.isPlayer) {
      this.ctx.camera.addShake(strength * 1.1)
      this.ctx.vibrate(Math.round(clamp(strength, 0.1, 1) * 90))
      if (strength > 0.25) this.ctx.audio.impact(strength)
    }
  }

  onEnter() {
    this.ctx.hud.setVisible(true)
    this.ctx.minimap.setTrack(this.ctx.track)
    this.ctx.hud.toast('3 圈竞速 · 击败 AI 对手', 2.6)
  }

  onExit() {
    for (const r of this.racers) r.vehicle.dispose()
    this.racers = []
  }

  protected onLapComplete(r: Racer) {
    const lapTime = this.timeSinceStart - r.lapStart
    r.lapStart = this.timeSinceStart
    r.lastLap = lapTime
    if (lapTime > 3 && (r.best === 0 || lapTime < r.best)) r.best = lapTime

    if (r.isPlayer) {
      if (r.laps >= this.totalLaps) {
        r.finished = true
        r.finishTime = this.timeSinceStart
        this.finishRace()
      } else if (r.laps > 0) {
        this.ctx.hud.toast(`LAP ${r.laps} · ${lapTime.toFixed(2)}s`, 2)
        this.ctx.hud.showCenter(`LAP ${r.laps + 1}`)
        this.ctx.audio.beep(660, 0.15, 'triangle')
      }
    } else if (r.laps >= this.totalLaps && !r.finished) {
      r.finished = true
      r.finishTime = this.timeSinceStart
    }
  }

  private finishRace() {
    if (this.finished) return
    this.finished = true
    const sorted = this.updatePlaces()
    const rows = sorted.map(
      (r, i) =>
        `<div class="${i === 0 ? 'gold' : ''}">${i + 1}. ${r.name} — ${
          r.finished ? r.finishTime.toFixed(2) + 's' : 'DNF'
        } ${r.best ? '· 最快圈 ' + r.best.toFixed(2) + 's' : ''}</div>`
    )
    const place = this.racers[0].place
    const title = place === 1 ? '🏆 冠军！' : `第 ${place} 名`
    setTimeout(() => {
      this.ctx.finish(title, rows)
    }, 1600)
  }

  update(dt: number, playerInput: VehicleInputLike) {
    const started = this.tickCountdown(dt)
    if (started) this.timeSinceStart += dt
    this.raceTime = this.timeSinceStart

    for (const r of this.racers) {
      let input: VehicleInputLike
      if (r.isPlayer) {
        input = started ? playerInput : { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }
        r.vehicle.setThrottleCache(input.throttle)
      } else {
        input = r.ai!.update(dt, this.vehicles, started)
        r.vehicle.setThrottleCache(input.throttle)
      }
      r.vehicle.update(dt, input)
    }

    this.updateProgress(dt)
    this.updatePlaces()
  }

  respawnPlayer() {
    const r = this.racers[0]
    const pos = this.ctx.track.resetPointAtS(r.s - 6, 0)
    r.vehicle.reset(pos, this.ctx.track.headingAtS(r.s - 6))
  }

  hudData(): HudData {
    const me = this.racers[0]
    const sorted = [...this.racers].sort((a, b) => a.place - b.place)
    const leader = sorted[0]
    return {
      speed: me.vehicle.speedKmh,
      gear: me.vehicle.getGear(),
      nitro01: me.vehicle.nitroAmount / me.vehicle.tuning.nitroCapacity,
      lap: Math.min(me.laps + 1, this.totalLaps),
      totalLaps: this.totalLaps,
      time: this.timeSinceStart - me.lapStart,
      best: me.best,
      delta: null,
      position: me.place,
      total: this.racers.length,
      health01: 1,
      showHealth: false,
      scoreText: '',
      standings: sorted.map((r) => ({
        name: r.name,
        value: r === leader ? 'LEADER' : formatGap(leader, r),
        me: r.isPlayer,
      })),
    }
  }

  minimapDots(): MinimapDot[] {
    return this.racers.map((r) => {
      const p = r.vehicle.mesh.group.position
      return { x: p.x, z: p.z, color: minimapColorFromHex(r.color), me: r.isPlayer }
    })
  }
}
