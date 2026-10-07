import { clamp, formatTime, formatDelta } from '../utils/math'

export interface StandingEntry {
  name: string
  value: string
  me: boolean
}

export interface HudData {
  speed: number
  gear: number
  nitro01: number
  lap: number
  totalLaps: number
  time: number
  best: number
  delta: number | null
  position: number
  total: number
  health01: number
  showHealth: boolean
  scoreText: string
  standings: StandingEntry[]
}

const ARC_LEN = 386 // 270° 弧长（r=82）
const CIRC = 515

export class HUD {
  private el = {
    hud: document.getElementById('hud')!,
    lap: document.getElementById('hud-lap')!,
    time: document.getElementById('hud-time')!,
    best: document.getElementById('hud-best')!,
    delta: document.getElementById('hud-delta')!,
    pos: document.getElementById('hud-pos')!,
    standings: document.getElementById('hud-standings')!,
    speed: document.getElementById('hud-speed')!,
    gear: document.getElementById('hud-gear')!,
    arc: document.getElementById('spd-arc')!,
    ticks: document.getElementById('spd-ticks')!,
    nitro: document.getElementById('hud-nitro')!,
    healthWrap: document.getElementById('hud-health-wrap')!,
    health: document.getElementById('hud-health')!,
    score: document.getElementById('hud-score')!,
    center: document.getElementById('hud-center')!,
    wrongway: document.getElementById('hud-wrongway')!,
    toast: document.getElementById('hud-toast')!,
    fps: document.getElementById('fps')!,
  }

  private lastSpeed = 0
  private toastTimer = 0

  constructor() {
    this.buildTicks()
  }

  private buildTicks() {
    const g = this.el.ticks
    let html = ''
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * 270 - 135
      const rad = ((a + 90) * Math.PI) / 180
      const r1 = i % 5 === 0 ? 62 : 68
      const r2 = 74
      const x1 = 100 + Math.cos(rad) * r1
      const y1 = 100 + Math.sin(rad) * r1
      const x2 = 100 + Math.cos(rad) * r2
      const y2 = 100 + Math.sin(rad) * r2
      const w = i % 5 === 0 ? 3 : 1.5
      const color = i > 7 ? '#ff3b6b' : 'rgba(255,255,255,0.45)'
      html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
        1
      )}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`
    }
    g.innerHTML = html
  }

  setVisible(v: boolean) {
    this.el.hud.classList.toggle('hidden', !v)
  }

  setFps(fps: number, show: boolean) {
    this.el.fps.classList.toggle('hidden', !show)
    this.el.fps.textContent = `${fps} FPS`
  }

  showCenter(text: string) {
    const el = this.el.center
    el.textContent = text
    el.classList.remove('show')
    // 强制重排以重启动画
    void el.offsetWidth
    el.classList.add('show')
  }

  toast(text: string, duration = 2.2) {
    this.el.toast.textContent = text
    this.el.toast.classList.add('show')
    this.toastTimer = duration
  }

  setWrongWay(on: boolean) {
    this.el.wrongway.classList.toggle('hidden', !on)
  }

  update(dt: number, d: HudData) {
    // 速度表
    const maxSpeed = 320
    const frac = clamp(d.speed / maxSpeed, 0, 1)
    this.el.arc.style.strokeDasharray = `${(ARC_LEN * frac).toFixed(1)} ${CIRC}`
    const shown = Math.round(this.lastSpeed + (d.speed - this.lastSpeed) * 0.4)
    this.lastSpeed = shown
    this.el.speed.textContent = String(shown)
    this.el.gear.textContent = d.gear === 0 ? 'N' : String(d.gear)
    this.el.nitro.style.height = `${(d.nitro01 * 100).toFixed(0)}%`

    // 圈数 / 计时
    this.el.lap.textContent = d.totalLaps > 0 ? `${Math.min(d.lap, d.totalLaps)}/${d.totalLaps}` : `${d.lap}`
    this.el.time.textContent = formatTime(d.time)
    this.el.best.textContent = d.best > 0 ? formatTime(d.best) : '--:--.--'
    if (d.delta === null) {
      this.el.delta.textContent = ''
      this.el.delta.className = 'delta'
    } else {
      this.el.delta.textContent = formatDelta(d.delta)
      this.el.delta.className = `delta ${d.delta <= 0 ? 'good' : 'bad'}`
    }

    // 名次
    this.el.pos.innerHTML = `<b>${d.position}</b><span>/${d.total}</span>`

    // 排行榜
    if (d.standings.length) {
      this.el.standings.innerHTML = d.standings
        .map(
          (s, i) =>
            `<div class="${s.me ? 'me' : ''}"><span>${i + 1}. ${s.name}</span><span>${s.value}</span></div>`
        )
        .join('')
      this.el.standings.classList.remove('hidden')
    } else {
      this.el.standings.classList.add('hidden')
    }

    // 血条（战斗模式）
    this.el.healthWrap.classList.toggle('hidden', !d.showHealth)
    if (d.showHealth) {
      this.el.health.style.width = `${(d.health01 * 100).toFixed(0)}%`
      this.el.score.textContent = d.scoreText
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show')
    }
  }
}
