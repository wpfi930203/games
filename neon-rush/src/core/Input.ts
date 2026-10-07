import { clamp, damp } from '../utils/math'

export interface VehicleInput {
  /** 0..1 */
  throttle: number
  /** 0..1 */
  brake: number
  /** -1..1 */
  steer: number
  handbrake: boolean
  nitro: boolean
}

export const emptyInput = (): VehicleInput => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  nitro: false,
})

export class InputManager {
  private keys = new Set<string>()
  /** 摇杆向量 (-1..1) */
  private stick = { x: 0, y: 0, active: false }
  /** 触摸按钮 */
  private btn = { nitro: false, handbrake: false }

  private steerSmoothed = 0
  private throttleSmoothed = 0

  /** 一次性事件（被读取后清空） */
  cameraToggle = false
  respawnPressed = false
  pausePressed = false
  debugToggle = false
  muteToggle = false

  enabled = true

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, { passive: false })
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.code
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
      ].includes(k)
    ) {
      e.preventDefault()
    }
    if (!e.repeat) {
      if (k === 'KeyC') this.cameraToggle = true
      if (k === 'KeyR') this.respawnPressed = true
      if (k === 'Escape') this.pausePressed = true
      if (k === 'KeyG') this.debugToggle = true
      if (k === 'KeyM') this.muteToggle = true
    }
    this.keys.add(k)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  /** 由 TouchControls 调用 */
  setStick(x: number, y: number, active: boolean) {
    this.stick.x = x
    this.stick.y = y
    this.stick.active = active
  }

  setButton(name: 'nitro' | 'handbrake', value: boolean) {
    this.btn[name] = value
  }

  private keyDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c))
  }

  /** 生成本帧玩家输入（含平滑） */
  sample(dt: number): VehicleInput {
    if (!this.enabled) {
      this.steerSmoothed = damp(this.steerSmoothed, 0, 10, dt)
      return { throttle: 0, brake: 0, steer: this.steerSmoothed, handbrake: false, nitro: false }
    }

    let steerTarget = 0
    let throttleTarget = 0
    let brakeTarget = 0

    // 键盘
    if (this.keyDown('KeyA', 'ArrowLeft')) steerTarget -= 1
    if (this.keyDown('KeyD', 'ArrowRight')) steerTarget += 1
    if (this.keyDown('KeyW', 'ArrowUp')) throttleTarget = 1
    if (this.keyDown('KeyS', 'ArrowDown')) brakeTarget = 1

    // 触摸摇杆
    if (this.stick.active) {
      steerTarget = clamp(steerTarget + this.stick.x, -1, 1)
      if (this.stick.y < -0.08) throttleTarget = clamp(throttleTarget + -this.stick.y, 0, 1)
      if (this.stick.y > 0.08) brakeTarget = clamp(brakeTarget + this.stick.y, 0, 1)
    }

    // 转向平滑：回中比打方向更快
    const rate = Math.abs(steerTarget) > 0.01 ? 7.5 : 12
    this.steerSmoothed = damp(this.steerSmoothed, steerTarget, rate, dt)
    if (Math.abs(this.steerSmoothed) < 0.001) this.steerSmoothed = 0

    this.throttleSmoothed = damp(this.throttleSmoothed, throttleTarget, 14, dt)

    return {
      throttle: throttleTarget,
      brake: brakeTarget,
      steer: this.steerSmoothed,
      handbrake: this.keyDown('Space') || this.btn.handbrake,
      nitro: this.keyDown('ShiftLeft', 'ShiftRight', 'KeyF') || this.btn.nitro,
    }
  }
}
