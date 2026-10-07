import { clamp } from '../utils/math'

/**
 * 极简程序化音效：引擎（锯齿波 + 低通）、氮气（噪声）、撞击（低频冲击）。
 * 不依赖任何音频资源文件。
 */
export class AudioManager {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private engineOsc!: OscillatorNode
  private engineOsc2!: OscillatorNode
  private engineGain!: GainNode
  private engineFilter!: BiquadFilterNode
  private noiseBuffer!: AudioBuffer
  private nitroSrc!: AudioBufferSourceNode
  private nitroGain!: GainNode
  private windGain!: GainNode
  enabled = true
  started = false

  /** 需要在用户手势中调用 */
  start() {
    if (this.started) return
    const Ctor = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctor) return
    this.ctx = new Ctor()
    const ctx = this.ctx

    this.master = ctx.createGain()
    this.master.gain.value = this.enabled ? 0.5 : 0
    this.master.connect(ctx.destination)

    // ---- 引擎 ----
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0
    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 900
    this.engineGain.connect(this.engineFilter)
    this.engineFilter.connect(this.master)

    this.engineOsc = ctx.createOscillator()
    this.engineOsc.type = 'sawtooth'
    this.engineOsc.frequency.value = 60
    this.engineOsc.connect(this.engineGain)
    this.engineOsc.start()

    this.engineOsc2 = ctx.createOscillator()
    this.engineOsc2.type = 'square'
    this.engineOsc2.frequency.value = 30
    const g2 = ctx.createGain()
    g2.gain.value = 0.35
    this.engineOsc2.connect(g2)
    g2.connect(this.engineGain)
    this.engineOsc2.start()

    // ---- 噪声（氮气 / 风） ----
    const len = ctx.sampleRate * 2
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

    this.nitroSrc = ctx.createBufferSource()
    this.nitroSrc.buffer = this.noiseBuffer
    this.nitroSrc.loop = true
    this.nitroGain = ctx.createGain()
    this.nitroGain.gain.value = 0
    const nitroFilter = ctx.createBiquadFilter()
    nitroFilter.type = 'bandpass'
    nitroFilter.frequency.value = 1400
    nitroFilter.Q.value = 0.8
    this.nitroSrc.connect(nitroFilter)
    nitroFilter.connect(this.nitroGain)
    this.nitroGain.connect(this.master)
    this.nitroSrc.start()

    // ---- 风噪（速度） ----
    const windSrc = ctx.createBufferSource()
    windSrc.buffer = this.noiseBuffer
    windSrc.loop = true
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0
    const windFilter = ctx.createBiquadFilter()
    windFilter.type = 'lowpass'
    windFilter.frequency.value = 500
    windSrc.connect(windFilter)
    windFilter.connect(this.windGain)
    this.windGain.connect(this.master)
    windSrc.start()

    this.started = true
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (this.master) this.master.gain.value = on ? 0.5 : 0
  }

  /**
   * @param rpm01 0..1 转速
   * @param speed01 0..1 速度
   * @param nitro 是否氮气
   * @param active 引擎是否运转（菜单/暂停时静音）
   */
  update(rpm01: number, speed01: number, nitro: boolean, active = true) {
    if (!this.ctx || !this.started) return
    const t = this.ctx.currentTime
    const base = 55 + rpm01 * 240 + (nitro ? 60 : 0)
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.05)
    this.engineOsc2.frequency.setTargetAtTime(base * 0.5, t, 0.05)
    this.engineFilter.frequency.setTargetAtTime(500 + rpm01 * 2600 + (nitro ? 900 : 0), t, 0.08)
    this.engineGain.gain.setTargetAtTime(active ? 0.06 + rpm01 * 0.1 : 0, t, 0.1)
    this.nitroGain.gain.setTargetAtTime(nitro && active ? 0.09 : 0, t, 0.08)
    this.windGain.gain.setTargetAtTime(active ? clamp(speed01, 0, 1) * 0.045 : 0, t, 0.15)
  }

  /** 撞击音：低频冲击 + 噪声爆点 */
  impact(strength01: number) {
    if (!this.ctx || !this.started || !this.enabled) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(160, t)
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.22)
    const g = ctx.createGain()
    g.gain.setValueAtTime(clamp(strength01, 0, 1) * 0.7, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + 0.3)

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const nf = ctx.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = 2200
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(clamp(strength01, 0, 1) * 0.35, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    src.connect(nf)
    nf.connect(ng)
    ng.connect(this.master)
    src.start(t)
    src.stop(t + 0.2)
  }

  /** 提示音（倒计时 / 圈速） */
  beep(freq: number, dur = 0.12, type: OscillatorType = 'triangle') {
    if (!this.ctx || !this.started || !this.enabled) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.18, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }
}
