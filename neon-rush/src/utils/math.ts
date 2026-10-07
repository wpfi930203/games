export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** 帧率无关的指数平滑 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt))

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export const randomRange = (a: number, b: number): number => a + Math.random() * (b - a)

export const randomInt = (a: number, b: number): number => Math.floor(randomRange(a, b + 1))

export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

/** 秒 -> m:ss.xx */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--.--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.floor((seconds * 100) % 100)
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

/** 秒 -> +0.00 / -0.00 */
export function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? '+' : '-'
  return `${sign}${Math.abs(seconds).toFixed(2)}`
}

export const shortestAngle = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}
