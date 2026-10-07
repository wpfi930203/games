import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { GameMode, type ModeContext, type VehicleInputLike } from './Mode'
import { Vehicle } from '../vehicle/Vehicle'
import type { AIDriver } from '../vehicle/AIDriver'
import type { HudData } from '../ui/HUD'
import type { MinimapDot } from '../ui/Minimap'
import { minimapColorFromHex } from '../ui/Minimap'
import { SurfaceBody } from '../physics/PhysicsWorld'
import { clamp, randomRange } from '../utils/math'

const CENTER = new THREE.Vector3(-520, 0, -520)
const RADIUS = 68
const AI_COLORS = [0xff5a5a, 0xffc93c, 0x9b7bff]
const MATCH_TIME = 180

interface Fighter {
  vehicle: Vehicle
  name: string
  color: number
  isPlayer: boolean
  kills: number
  lives: number
  respawnAt: number
  boostUntil: number
  ai?: ArenaAI
}

/** 竞技场专用 AI：追击 + 撞击 + 残血撤退 */
class ArenaAI {
  private target: Vehicle | null = null
  private retarget = 0
  constructor(
    private self: Vehicle,
    private skill: number
  ) {}

  update(dt: number, fighters: Fighter[], pickups: Pickup[]): VehicleInputLike {
    const input: VehicleInputLike = {
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: false,
      nitro: false,
    }
    if (!this.self.alive) return input
    this.retarget -= dt

    const p = this.self.mesh.group.position
    const fwd = this.self.forwardVector()
    fwd.y = 0
    fwd.normalize()

    let goal: THREE.Vector3 | null = null

    // 残血找血包
    if (this.self.health < 35) {
      let best: Pickup | null = null
      let bd = Infinity
      for (const pk of pickups) {
        if (!pk.active || pk.kind !== 'health') continue
        const d = pk.position.distanceTo(p)
        if (d < bd) {
          bd = d
          best = pk
        }
      }
      if (best) goal = best.position
    }

    if (!goal) {
      if (!this.target || !this.target.alive || this.retarget <= 0) {
        this.retarget = 2.5
        let bd = Infinity
        this.target = null
        for (const f of fighters) {
          if (f.vehicle === this.self || !f.vehicle.alive) continue
          const d = f.vehicle.mesh.group.position.distanceTo(p)
          if (d < bd) {
            bd = d
            this.target = f.vehicle
          }
        }
      }
      if (this.target) goal = this.target.mesh.group.position
    }
    if (!goal) return input

    const to = new THREE.Vector3(goal.x - p.x, 0, goal.z - p.z)
    const dist = to.length() || 1
    to.divideScalar(dist)
    const fwdDot = fwd.x * to.x + fwd.z * to.z
    const leftDot = fwd.z * to.x - fwd.x * to.z
    input.steer = clamp(-Math.atan2(leftDot, fwdDot) * 1.9, -1, 1)

    const speed = Math.abs(this.self.forwardSpeed)
    if (fwdDot < 0.1 && dist < 18) {
      // 目标在身后 -> 减速掉头
      input.brake = 0.8
      input.throttle = 0
      input.steer = Math.sign(input.steer) || 1
    } else {
      input.throttle = 1
      if (Math.abs(input.steer) > 0.7 && speed > 24) input.throttle = 0.45
    }
    input.nitro = dist > 16 && dist < 70 && fwdDot > 0.9 && this.self.nitroAmount > 50
    input.handbrake = Math.abs(input.steer) > 0.85 && speed > 26 && this.skill > 0.85
    return input
  }
}

interface Pickup {
  mesh: THREE.Mesh
  kind: 'health' | 'nitro' | 'damage'
  position: THREE.Vector3
  active: boolean
  respawnAt: number
}

export class ArenaMode extends GameMode {
  player!: Vehicle
  vehicles: Vehicle[] = []
  ais: AIDriver[] = []

  private group = new THREE.Group()
  private fighters: Fighter[] = []
  private bodyToFighter = new Map<CANNON.Body, Fighter>()
  private pickups: Pickup[] = []
  private barrels: { body: CANNON.Body; mesh: THREE.Mesh }[] = []
  private timeLeft = MATCH_TIME
  private elapsed = 0
  private tmp = new THREE.Vector3()

  constructor(ctx: ModeContext, aiCount = 3) {
    super('arena', ctx)
    this.buildArena()
    this.spawnFighters(ctx, aiCount)
    this.spawnPickups()
  }

  // ------------------------------------------------------------------
  private buildArena() {
    const scene = this.ctx.scene
    const physics = this.ctx.physics
    this.group.name = 'arena'
    scene.add(this.group)

    // 地面
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS + 4, 64),
      new THREE.MeshStandardMaterial({ color: 0x3a3f4d, roughness: 0.95 })
    )
    floor.geometry.rotateX(-Math.PI / 2)
    floor.position.copy(CENTER)
    floor.position.y = 0.03
    floor.receiveShadow = true
    this.group.add(floor)

    const floorBody = new CANNON.Body({
      mass: 0,
      material: physics.materials.road,
      shape: new CANNON.Box(new CANNON.Vec3(RADIUS + 4, 0.5, RADIUS + 4)),
    }) as SurfaceBody
    floorBody.surfaceType = 'road'
    floorBody.position.set(CENTER.x, -0.5, CENTER.z)
    physics.world.addBody(floorBody)

    // 中央图案
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(14, 18, 48),
      new THREE.MeshStandardMaterial({
        color: 0x37f5d8,
        emissive: 0x1ba796,
        emissiveIntensity: 0.8,
        side: THREE.DoubleSide,
      })
    )
    ring.geometry.rotateX(-Math.PI / 2)
    ring.position.set(CENTER.x, 0.06, CENTER.z)
    this.group.add(ring)

    // 环形高墙
    const segments = 40
    const wallH = 7
    const wallGeo = new THREE.BoxGeometry((2 * Math.PI * RADIUS) / segments + 0.6, wallH, 1.2)
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x4a5468,
      roughness: 0.7,
      metalness: 0.4,
      flatShading: true,
    })
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const x = CENTER.x + Math.cos(a) * RADIUS
      const z = CENTER.z + Math.sin(a) * RADIUS
      const body = new CANNON.Body({
        mass: 0,
        material: physics.materials.wall,
        shape: new CANNON.Box(
          new CANNON.Vec3((2 * Math.PI * RADIUS) / segments / 2 + 0.3, wallH / 2, 0.6)
        ),
      }) as SurfaceBody
      body.surfaceType = 'wall'
      body.position.set(x, wallH / 2, z)
      body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a + Math.PI / 2)
      physics.world.addBody(body)

      const m = new THREE.Mesh(wallGeo, wallMat)
      m.position.set(x, wallH / 2, z)
      m.rotation.y = -a + Math.PI / 2
      m.castShadow = true
      m.receiveShadow = true
      this.group.add(m)
    }

    // 掩体柱
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x4a5163,
      roughness: 0.8,
      flatShading: true,
    })
    const pillars: [number, number, number, number][] = [
      [0, 0, 34, 0],
      [24, 24, 30, 1],
      [-24, -24, 30, 1],
      [30, -18, 22, 2],
      [-30, 18, 22, 2],
    ]
    for (const [ox, oz, r, tier] of pillars) {
      const h = 6 - tier
      const w = 5 - tier * 0.7
      const x = CENTER.x + ox
      const z = CENTER.z + oz
      const body = new CANNON.Body({
        mass: 0,
        material: physics.materials.wall,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, w / 2)),
      }) as SurfaceBody
      body.surfaceType = 'wall'
      body.position.set(x, h / 2, z)
      physics.world.addBody(body)
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), pillarMat)
      m.position.set(x, h / 2, z)
      m.rotation.y = r
      m.castShadow = true
      m.receiveShadow = true
      this.group.add(m)
    }

    // 爆炸油桶
    const barrelGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.4, 10)
    const barrelMat = new THREE.MeshStandardMaterial({
      color: 0xd94a2b,
      emissive: 0x521206,
      roughness: 0.55,
      metalness: 0.35,
      flatShading: true,
    })
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3
      const r = 22 + (i % 3) * 14
      const x = CENTER.x + Math.cos(a) * r
      const z = CENTER.z + Math.sin(a) * r
      const body = new CANNON.Body({
        mass: 16,
        material: physics.materials.obstacle,
        shape: new CANNON.Cylinder(0.55, 0.55, 1.4, 10),
      }) as SurfaceBody
      body.surfaceType = 'obstacle'
      body.position.set(x, 0.72, z)
      body.linearDamping = 0.3
      body.angularDamping = 0.4
      physics.world.addBody(body)
      const m = new THREE.Mesh(barrelGeo, barrelMat)
      m.castShadow = true
      this.group.add(m)
      this.barrels.push({ body, mesh: m })
    }
  }

  private spawnFighters(ctx: ModeContext, aiCount: number) {
    const spawnPoints: THREE.Vector3[] = []
    for (let i = 0; i < aiCount + 1; i++) {
      const a = (i / (aiCount + 1)) * Math.PI * 2
      spawnPoints.push(
        new THREE.Vector3(CENTER.x + Math.cos(a) * (RADIUS - 22), 1.4, CENTER.z + Math.sin(a) * (RADIUS - 22))
      )
    }

    const player = new Vehicle(
      ctx.scene,
      ctx.physics,
      spawnPoints[0],
      Math.atan2(-Math.cos(0), -Math.sin(0)),
      ctx.playerColor,
      ctx.tuning,
      'player'
    )
    player.isPlayer = true
    this.player = player
    this.fighters.push({
      vehicle: player,
      name: 'YOU',
      color: ctx.playerColor,
      isPlayer: true,
      kills: 0,
      lives: 3,
      respawnAt: 0,
      boostUntil: 0,
    })

    for (let i = 0; i < aiCount; i++) {
      const c = AI_COLORS[i % AI_COLORS.length]
      const v = new Vehicle(
        ctx.scene,
        ctx.physics,
        spawnPoints[i + 1],
        Math.atan2(-Math.cos(((i + 1) / (aiCount + 1)) * Math.PI * 2), -Math.sin(((i + 1) / (aiCount + 1)) * Math.PI * 2)),
        c,
        ctx.tuning,
        `AI ${i + 1}`
      )
      const f: Fighter = {
        vehicle: v,
        name: `AI ${i + 1}`,
        color: c,
        isPlayer: false,
        kills: 0,
        lives: 3,
        respawnAt: 0,
        boostUntil: 0,
        ai: new ArenaAI(v, 0.82 + i * 0.06),
      }
      this.fighters.push(f)
    }

    this.vehicles = this.fighters.map((f) => f.vehicle)
    for (const f of this.fighters) {
      f.vehicle.fx = ctx.effects
      f.vehicle.maxHealth = 100
      f.vehicle.health = 100
      this.bodyToFighter.set(f.vehicle.body, f)
      f.vehicle.onImpact = (strength, other) => this.onImpact(f, strength, other)
    }
  }

  private spawnPickups() {
    const kinds: Pickup['kind'][] = ['health', 'nitro', 'damage']
    for (let i = 0; i < 6; i++) {
      const kind = kinds[i % 3]
      const a = (i / 6) * Math.PI * 2 + 0.5
      const r = i % 2 === 0 ? 40 : 18
      const pos = new THREE.Vector3(CENTER.x + Math.cos(a) * r, 1.1, CENTER.z + Math.sin(a) * r)
      const color = kind === 'health' ? 0x4dff9e : kind === 'nitro' ? 0x49d8ff : 0xff5a7a
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.85, 0),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.6,
          metalness: 0.4,
          roughness: 0.25,
        })
      )
      mesh.position.copy(pos)
      mesh.castShadow = true
      this.group.add(mesh)
      this.pickups.push({ mesh, kind, position: pos, active: true, respawnAt: 0 })
    }
  }

  // ------------------------------------------------------------------
  private onImpact(f: Fighter, strength: number, other: CANNON.Body | null) {
    if (strength < 0.12) return
    const otherFighter = other ? this.bodyToFighter.get(other) : undefined
    const dmgScale = this.elapsed > f.boostUntil ? 1 : 2

    if (otherFighter) {
      otherFighter.vehicle.applyDamage(strength * 26 * dmgScale)
      f.vehicle.applyDamage(strength * 9)
      if (f.isPlayer) {
        this.ctx.camera.addShake(strength * 1.2)
        this.ctx.vibrate(Math.round(clamp(strength, 0.1, 1) * 110))
      }
    } else {
      f.vehicle.applyDamage(strength * 8)
      if (f.isPlayer) {
        this.ctx.camera.addShake(strength * 0.8)
        this.ctx.vibrate(Math.round(clamp(strength, 0.1, 1) * 70))
      }
    }
    this.ctx.audio.impact(f.isPlayer ? strength : strength * 0.3)

    if (otherFighter && !otherFighter.vehicle.alive && otherFighter.respawnAt <= 0) {
      this.registerKill(f, otherFighter)
    }

    // 撞飞油桶 -> 爆炸
    for (const b of this.barrels) {
      if (b.body === other) this.explodeBarrel(b)
    }
  }

  private explodeBarrel(b: { body: CANNON.Body; mesh: THREE.Mesh }) {
    const p = b.body.position
    const pos = new THREE.Vector3(p.x, p.y, p.z)
    this.ctx.effects.explosion(pos, 1.2)
    this.ctx.audio.impact(0.9)
    for (const f of this.fighters) {
      const d = f.vehicle.mesh.group.position.distanceTo(pos)
      if (d < 9) {
        f.vehicle.applyDamage((1 - d / 9) * 34)
        if (f.isPlayer) this.ctx.camera.addShake(0.8)
      }
    }
    // 复位油桶
    b.body.position.set(
      CENTER.x + randomRange(-50, 50),
      0.72,
      CENTER.z + randomRange(-50, 50)
    )
    b.body.velocity.setZero()
    b.body.angularVelocity.setZero()
  }

  private registerKill(killer: Fighter, victim: Fighter) {
    killer.kills++
    victim.lives--
    victim.respawnAt = this.elapsed + 3
    if (killer.isPlayer) {
      this.ctx.hud.toast(`击毁 ${victim.name}！+1`, 1.8)
      this.ctx.vibrate([40, 60, 90])
    }
    if (victim.lives <= 0) {
      victim.respawnAt = Infinity
      victim.vehicle.mesh.group.visible = false
    }
    this.checkMatchEnd()
  }

  private checkMatchEnd() {
    const alive = this.fighters.filter((f) => f.lives > 0)
    if (alive.length <= 1) this.endMatch()
  }

  private endMatch() {
    if (this.finished) return
    this.finished = true
    const sorted = [...this.fighters].sort((a, b) => b.kills - a.kills || b.lives - a.lives)
    const rows = sorted.map(
      (f, i) =>
        `<div class="${i === 0 ? 'gold' : ''}">${i + 1}. ${f.name} — 击毁 ${f.kills} · 剩余生命 ${
          Math.max(0, f.lives)
        }</div>`
    )
    const me = this.fighters[0]
    const title = sorted[0] === me ? '🏆 竞技场之王' : `第 ${sorted.findIndex((f) => f === me) + 1} 名`
    setTimeout(() => this.ctx.finish(title, rows), 1400)
  }

  // ------------------------------------------------------------------
  onEnter() {
    this.ctx.hud.setVisible(true)
    this.ctx.minimap.setArena(CENTER.x, CENTER.z, RADIUS)
    this.ctx.hud.toast('竞技场：撞毁对手 · 拾取补给', 3)
  }

  onExit() {
    for (const f of this.fighters) f.vehicle.dispose()
    this.fighters = []
    this.vehicles = []
    this.ctx.scene.remove(this.group)
  }

  respawnPlayer() {
    const a = Math.random() * Math.PI * 2
    const pos = new THREE.Vector3(
      CENTER.x + Math.cos(a) * (RADIUS - 24),
      1.4,
      CENTER.z + Math.sin(a) * (RADIUS - 24)
    )
    this.player.reset(pos, Math.atan2(CENTER.x - pos.x, CENTER.z - pos.z))
  }

  update(dt: number, playerInput: VehicleInputLike) {
    const started = this.tickCountdown(dt)
    if (started) {
      this.elapsed += dt
      this.timeLeft -= dt
    }
    this.raceTime = this.elapsed

    for (const f of this.fighters) {
      if (!f.vehicle.alive) {
        if (f.respawnAt !== Infinity && this.elapsed >= f.respawnAt) {
          const a = Math.random() * Math.PI * 2
          const pos = new THREE.Vector3(
            CENTER.x + Math.cos(a) * (RADIUS - 24),
            1.4,
            CENTER.z + Math.sin(a) * (RADIUS - 24)
          )
          f.vehicle.revive(pos, Math.atan2(CENTER.x - pos.x, CENTER.z - pos.z))
          f.respawnAt = 0
        } else {
          f.vehicle.update(dt, { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false })
          continue
        }
      }
      const input = started
        ? f.isPlayer
          ? playerInput
          : f.ai!.update(dt, this.fighters, this.pickups)
        : { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }
      f.vehicle.setThrottleCache(input.throttle)
      f.vehicle.update(dt, input)
    }

    // 油桶网格同步
    for (const b of this.barrels) {
      const p = b.body.position
      const q = b.body.quaternion
      b.mesh.position.set(p.x, p.y, p.z)
      b.mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }

    // 拾取
    const t = performance.now() * 0.002
    for (const pk of this.pickups) {
      pk.mesh.rotation.y = t
      pk.mesh.position.y = 1.1 + Math.sin(t * 0.8) * 0.18
      if (!pk.active) {
        if (this.elapsed >= pk.respawnAt) {
          pk.active = true
          pk.mesh.visible = true
        }
        continue
      }
      for (const f of this.fighters) {
        if (!f.vehicle.alive) continue
        if (f.vehicle.mesh.group.position.distanceTo(pk.position) < 3) {
          pk.active = false
          pk.mesh.visible = false
          pk.respawnAt = this.elapsed + 9
          this.applyPickup(f, pk.kind)
          break
        }
      }
    }

    if (this.timeLeft <= 0) this.endMatch()
  }

  private applyPickup(f: Fighter, kind: Pickup['kind']) {
    switch (kind) {
      case 'health':
        f.vehicle.health = Math.min(f.vehicle.maxHealth, f.vehicle.health + 35)
        break
      case 'nitro':
        f.vehicle.nitroAmount = f.vehicle.tuning.nitroCapacity
        break
      case 'damage':
        f.boostUntil = this.elapsed + 10
        break
    }
    if (f.isPlayer) {
      this.ctx.audio.beep(kind === 'health' ? 720 : 520, 0.12, 'triangle')
      this.ctx.hud.toast(
        kind === 'health' ? '+35 装甲' : kind === 'nitro' ? '氮气已充满' : '双倍伤害 10s',
        1.6
      )
    }
  }

  hudData(): HudData {
    const me = this.fighters[0]
    const sorted = [...this.fighters].sort((a, b) => b.kills - a.kills || b.lives - a.lives)
    return {
      speed: me.vehicle.speedKmh,
      gear: me.vehicle.getGear(),
      nitro01: me.vehicle.nitroAmount / me.vehicle.tuning.nitroCapacity,
      lap: 1,
      totalLaps: 0,
      time: Math.max(0, this.timeLeft),
      best: 0,
      delta: null,
      position: sorted.findIndex((f) => f === me) + 1,
      total: this.fighters.length,
      health01: me.vehicle.health / me.vehicle.maxHealth,
      showHealth: true,
      scoreText: `KILLS ${me.kills} · LIVES ${Math.max(0, me.lives)}${
        this.elapsed < me.boostUntil ? ' · x2 DMG' : ''
      }`,
      standings: sorted.map((f) => ({
        name: f.name,
        value: `${f.kills} K · ${Math.max(0, f.lives)}♥`,
        me: f.isPlayer,
      })),
    }
  }

  minimapDots(): MinimapDot[] {
    return this.fighters
      .filter((f) => f.vehicle.alive)
      .map((f) => {
        const p = f.vehicle.mesh.group.position
        return {
          x: p.x,
          z: p.z,
          color: minimapColorFromHex(f.color),
          me: f.isPlayer,
        }
      })
      .concat(
        this.pickups
          .filter((p) => p.active)
          .map((p) => ({
            x: p.position.x,
            z: p.position.z,
            color: p.kind === 'health' ? '#4dff9e' : p.kind === 'nitro' ? '#49d8ff' : '#ff5a7a',
            me: false,
          }))
      )
  }
}
