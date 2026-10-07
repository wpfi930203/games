import * as THREE from 'three'
import type { Track } from '../world/Track'

export interface MinimapDot {
  x: number
  z: number
  color: string
  me: boolean
  ghost?: boolean
}

/** 2D Canvas 小地图 */
export class Minimap {
  private ctx: CanvasRenderingContext2D
  private path: { x: number; y: number }[] = []
  private scale = 1
  private cx = 0
  private cz = 0
  private size: number

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.size = canvas.width
  }

  setTrack(track: Track) {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const p of track.center2D) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.y)
      maxZ = Math.max(maxZ, p.y)
    }
    const pad = 16
    const w = maxX - minX
    const h = maxZ - minZ
    this.scale = Math.min((this.size - pad * 2) / w, (this.size - pad * 2) / h)
    this.cx = (minX + maxX) / 2
    this.cz = (minZ + maxZ) / 2
    this.path = track.center2D.map((p) => this.toCanvas(p.x, p.y))
  }

  private toCanvas(x: number, z: number) {
    return {
      x: this.size / 2 + (x - this.cx) * this.scale,
      // 世界 Z 轴 -> 屏幕 Y 轴（保持左右一致：屏幕 X = 世界 X，屏幕 Y = 世界 Z）
      y: this.size / 2 + (z - this.cz) * this.scale,
    }
  }

  draw(dots: MinimapDot[]) {
    const ctx = this.ctx
    const s = this.size
    ctx.clearRect(0, 0, s, s)

    if (!this.path.length) return

    // 赛道
    ctx.beginPath()
    ctx.moveTo(this.path[0].x, this.path[0].y)
    for (let i = 1; i < this.path.length; i++) ctx.lineTo(this.path[i].x, this.path[i].y)
    ctx.closePath()
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = Math.max(5, 9 * this.scale * 4)
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.strokeStyle = 'rgba(55,245,216,0.5)'
    ctx.lineWidth = 1.6
    ctx.stroke()

    // 起跑线
    const start = this.path[0]
    ctx.fillStyle = '#ffd166'
    ctx.fillRect(start.x - 2.5, start.y - 2.5, 5, 5)

    // 车辆
    for (const d of dots) {
      const p = this.toCanvas(d.x, d.z)
      ctx.beginPath()
      if (d.ghost) {
        ctx.arc(p.x, p.y, d.me ? 4.6 : 3.6, 0, Math.PI * 2)
        ctx.strokeStyle = d.color
        ctx.lineWidth = 1.4
        ctx.stroke()
      } else {
        ctx.arc(p.x, p.y, d.me ? 4.6 : 3.4, 0, Math.PI * 2)
        ctx.fillStyle = d.color
        ctx.fill()
        if (d.me) {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.4
          ctx.stroke()
        }
      }
    }
  }

  /** 竞技场模式：圆形场地 */
  setArena(cx: number, cz: number, radius: number) {
    this.path = []
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2
      this.path.push(this.toCanvas(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius))
    }
    this.cx = cx
    this.cz = cz
    const pad = 18
    this.scale = (this.size - pad * 2) / (radius * 2)
  }

  setVisible(v: boolean) {
    this.canvas.style.display = v ? 'block' : 'none'
  }
}

export const minimapColorFromHex = (hex: number): string =>
  '#' + new THREE.Color(hex).getHexString()
