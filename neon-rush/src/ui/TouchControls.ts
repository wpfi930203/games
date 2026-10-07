import type { InputManager } from '../core/Input'

/**
 * 移动端触摸控制：
 * 左侧虚拟摇杆（上下油门/刹车，左右转向）+ 右侧按钮。
 */
export class TouchControls {
  enabled = false
  private zone: HTMLElement
  private base: HTMLElement
  private knob: HTMLElement
  private pointerId = -1
  private origin = { x: 0, y: 0 }
  private radius = 56
  private input: InputManager
  private buttons: Record<string, HTMLElement> = {}

  constructor(input: InputManager) {
    this.input = input
    this.zone = document.getElementById('stick-zone')!
    this.base = document.getElementById('stick-base')!
    this.knob = document.getElementById('stick-knob')!

    this.zone.addEventListener('pointerdown', this.onDown)
    this.zone.addEventListener('pointermove', this.onMove)
    this.zone.addEventListener('pointerup', this.onUp)
    this.zone.addEventListener('pointercancel', this.onUp)

    const bind = (id: string, key: 'nitro' | 'handbrake') => {
      const el = document.getElementById(id)!
      this.buttons[id] = el
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        el.classList.add('on')
        this.input.setButton(key, true)
      })
      const release = (e: Event) => {
        e.preventDefault()
        el.classList.remove('on')
        this.input.setButton(key, false)
      }
      el.addEventListener('pointerup', release)
      el.addEventListener('pointercancel', release)
      el.addEventListener('pointerleave', release)
    }
    bind('btn-nitro', 'nitro')
    bind('btn-hand', 'handbrake')

    document.getElementById('btn-cam')?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.input.cameraToggle = true
    })
    document.getElementById('btn-reset')?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.input.respawnPressed = true
    })
  }

  setVisible(v: boolean) {
    const el = document.getElementById('touch')!
    el.classList.toggle('hidden', !v)
    this.enabled = v
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointerId !== -1) return
    this.pointerId = e.pointerId
    this.zone.setPointerCapture(e.pointerId)
    const r = this.zone.getBoundingClientRect()
    // 摇杆出现在按下的位置
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    this.origin.x = x
    this.origin.y = y
    this.base.style.display = 'block'
    this.base.classList.add('active')
    this.base.style.left = `${Math.min(x - 66, r.width - 140)}px`
    this.base.style.bottom = `${Math.max(8, r.height - y - 66)}px`
    this.updateKnob(0, 0)
    this.input.setStick(0, 0, true)
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return
    const r = this.zone.getBoundingClientRect()
    let dx = e.clientX - r.left - this.origin.x
    let dy = e.clientY - r.top - this.origin.y
    const len = Math.hypot(dx, dy)
    if (len > this.radius) {
      dx = (dx / len) * this.radius
      dy = (dy / len) * this.radius
    }
    this.updateKnob(dx, dy)
    this.input.setStick(dx / this.radius, dy / this.radius, true)
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return
    this.pointerId = -1
    this.base.classList.remove('active')
    this.base.style.display = 'none'
    this.updateKnob(0, 0)
    this.input.setStick(0, 0, false)
  }

  private updateKnob(dx: number, dy: number) {
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
  }
}

export const isTouchDevice = (): boolean =>
  'ontouchstart' in window ||
  navigator.maxTouchPoints > 0 ||
  window.matchMedia('(pointer: coarse)').matches
