import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { PhysicsWorld, SurfaceBody } from '../physics/PhysicsWorld'
import type { Track } from './Track'
import { randomRange, randomInt } from '../utils/math'

const ROAD_MARGIN = 14

interface DynObstacle {
  body: CANNON.Body
  home: THREE.Vector3
  homeQuat: CANNON.Quaternion
  type: 'barrel' | 'tire' | 'cone'
}

/**
 * 场景装饰与动态障碍物。
 * 大量重复物体全部使用 InstancedMesh 渲染（移动优先）。
 */
export class Scenery {
  group = new THREE.Group()
  private dynamicObstacles: DynObstacle[] = []
  private barrels!: THREE.InstancedMesh
  private tires!: THREE.InstancedMesh
  private cones!: THREE.InstancedMesh
  private matrix = new THREE.Matrix4()
  private tmpPos = new THREE.Vector3()
  private tmpQuat = new THREE.Quaternion()
  private tmpScale = new THREE.Vector3(1, 1, 1)

  constructor(
    scene: THREE.Scene,
    private physics: PhysicsWorld,
    private track: Track,
    quality: 'low' | 'high' = 'high'
  ) {
    this.group.name = 'scenery'
    scene.add(this.group)
    const density = quality === 'high' ? 1 : 0.45

    this.buildGround(scene)
    this.buildTrees(density)
    this.buildRocks(density)
    this.buildLamps()
    this.buildMountains()
    this.buildGrandstands()
    this.buildObstacles(density)
    this.buildRamps()
  }

  // ------------------------------------------------------------------
  private buildGround(scene: THREE.Scene) {
    const size = 1400
    const seg = 48
    const geo = new THREE.PlaneGeometry(size, size, seg, seg)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const d = this.track.distanceToCenter(x, z)
      if (d > ROAD_MARGIN) {
        const h = (Math.sin(x * 0.012) * Math.cos(z * 0.009) + Math.sin(x * 0.05 + z * 0.03) * 0.4) * 1.6
        const k = Math.min(1, (d - ROAD_MARGIN) / 40)
        pos.setY(i, h * k)
      }
    }
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c4a32, roughness: 1, flatShading: true })
    const ground = new THREE.Mesh(geo, mat)
    ground.receiveShadow = true
    ground.position.y = -0.02
    this.group.add(ground)
  }

  // ------------------------------------------------------------------
  private scattered(count: number, minD: number, maxD: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    let guard = 0
    while (out.length < count && guard++ < count * 30) {
      const s = randomRange(0, this.track.length)
      const p = this.track.pointAtS(s)
      const i = this.track.indexAtS(s)
      const right = this.track.rightAt(i)
      const side = Math.random() < 0.5 ? -1 : 1
      const lateral = randomRange(minD, maxD) * side
      const x = p.x + right.x * lateral
      const z = p.z + right.z * lateral
      if (this.track.distanceToCenter(x, z) < minD) continue
      out.push(new THREE.Vector3(x, 0, z))
    }
    return out
  }

  private buildTrees(density: number) {
    const spots = this.scattered(Math.round(340 * density), 12, 90)
    if (!spots.length) return
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 2.2, 5)
    trunkGeo.translate(0, 1.1, 0)
    const trunk = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1, flatShading: true }),
      spots.length
    )
    const leafGeo = new THREE.ConeGeometry(1.5, 4.2, 6)
    leafGeo.translate(0, 3.9, 0)
    const leaf = new THREE.InstancedMesh(
      leafGeo,
      new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 0.95, flatShading: true }),
      spots.length
    )
    leaf.castShadow = true
    const m = new THREE.Matrix4()
    spots.forEach((p, i) => {
      const s = randomRange(0.7, 1.8)
      m.makeScale(s, s * randomRange(0.85, 1.25), s)
      m.setPosition(p.x, p.y, p.z)
      trunk.setMatrixAt(i, m)
      leaf.setMatrixAt(i, m)
    })
    trunk.instanceMatrix.needsUpdate = true
    leaf.instanceMatrix.needsUpdate = true
    this.group.add(trunk, leaf)
  }

  private buildRocks(density: number) {
    const spots = this.scattered(Math.round(150 * density), 10, 80)
    if (!spots.length) return
    const geo = new THREE.IcosahedronGeometry(1, 0)
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x6b6f76, roughness: 1, flatShading: true }),
      spots.length
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    spots.forEach((p, i) => {
      const s = randomRange(0.5, 2.4)
      e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
      q.setFromEuler(e)
      m.compose(new THREE.Vector3(p.x, s * 0.4, p.z), q, new THREE.Vector3(s, s * 0.7, s))
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    this.group.add(mesh)
  }

  private buildLamps() {
    const positions: THREE.Vector3[] = []
    const step = 46
    for (let s = 0; s < this.track.length; s += step) {
      const p = this.track.pointAtS(s)
      const i = this.track.indexAtS(s)
      const right = this.track.rightAt(i)
      const side = positions.length % 2 === 0 ? 1 : -1
      positions.push(new THREE.Vector3(p.x + right.x * 12 * side, 0, p.z + right.z * 12 * side))
    }
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 8, 6)
    poleGeo.translate(0, 4, 0)
    const poles = new THREE.InstancedMesh(
      poleGeo,
      new THREE.MeshStandardMaterial({ color: 0x333a45, metalness: 0.6, roughness: 0.5 }),
      positions.length
    )
    const headGeo = new THREE.BoxGeometry(1.5, 0.3, 0.6)
    const heads = new THREE.InstancedMesh(
      headGeo,
      new THREE.MeshStandardMaterial({
        color: 0xfff1c9,
        emissive: 0xffd98a,
        emissiveIntensity: 1.6,
      }),
      positions.length
    )
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    positions.forEach((p, i) => {
      m.makeTranslation(p.x, 0, p.z)
      poles.setMatrixAt(i, m)
      const heading = this.track.headingAtS(i * step)
      e.set(0, heading, 0)
      q.setFromEuler(e)
      m.compose(new THREE.Vector3(p.x, 8, p.z), q, new THREE.Vector3(1, 1, 1))
      heads.setMatrixAt(i, m)
    })
    poles.instanceMatrix.needsUpdate = true
    heads.instanceMatrix.needsUpdate = true
    this.group.add(poles, heads)
  }

  private buildMountains() {
    const count = 46
    const geo = new THREE.ConeGeometry(1, 1, 5)
    geo.translate(0, 0.5, 0)
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 1, flatShading: true }),
      count
    )
    const m = new THREE.Matrix4()
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + randomRange(-0.05, 0.05)
      const r = randomRange(330, 560)
      const h = randomRange(60, 190)
      const w = h * randomRange(0.7, 1.4)
      m.compose(
        new THREE.Vector3(Math.cos(a) * r, -6, Math.sin(a) * r),
        new THREE.Quaternion(),
        new THREE.Vector3(w, h, w)
      )
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    this.group.add(mesh)
  }

  private buildGrandstands() {
    // 起跑线旁的看台（箱体 + 实例化观众）
    const base = new THREE.Group()
    for (const side of [-1, 1]) {
      const s0 = side > 0 ? 30 : -60
      const p = this.track.pointAtS(s0)
      const i = this.track.indexAtS(s0)
      const right = this.track.rightAt(i)
      const heading = this.track.headingAtS(s0)
      for (let tier = 0; tier < 4; tier++) {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(34, 1.6, 3),
          new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.9, flatShading: true })
        )
        box.position.set(
          p.x + right.x * (20 + tier * 2.6) * side,
          0.8 + tier * 1.6,
          p.z + right.z * (20 + tier * 2.6) * side
        )
        box.rotation.y = heading
        box.castShadow = true
        box.receiveShadow = true
        base.add(box)
      }
    }
    // 观众
    const crowdCount = 420
    const crowd = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.45, 0.8, 0.45),
      new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 1, flatShading: true }),
      crowdCount
    )
    const colors = [0xff5a7a, 0x5ad2ff, 0xffd166, 0x8affc1, 0xc59bff, 0xffffff]
    const m = new THREE.Matrix4()
    const col = new THREE.Color()
    for (let i = 0; i < crowdCount; i++) {
      const side = i % 2 === 0 ? 1 : -1
      const s0 = side > 0 ? 30 : -60
      const p = this.track.pointAtS(s0)
      const idx = this.track.indexAtS(s0)
      const right = this.track.rightAt(idx)
      const along = randomRange(-16, 16)
      const heading = this.track.headingAtS(s0)
      const dirX = Math.sin(heading)
      const dirZ = Math.cos(heading)
      const tier = randomInt(0, 3)
      m.makeTranslation(
        p.x + right.x * (20 + tier * 2.6) * side + dirX * along,
        1.6 + tier * 1.6 + 0.4,
        p.z + right.z * (20 + tier * 2.6) * side + dirZ * along
      )
      crowd.setMatrixAt(i, m)
      col.setHex(colors[randomInt(0, colors.length - 1)])
      crowd.setColorAt(i, col)
    }
    crowd.instanceMatrix.needsUpdate = true
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true
    base.add(crowd)
    this.group.add(base)
  }

  // ------------------------------------------------------------------
  /**
   * 发车区判定：起跑线前 70m 到线后 130m。
   * 这一段是发车格 + 起步加速带，必须保持干净。
   */
  private inStartZone(s: number): boolean {
    const L = this.track.length
    return s > L - 70 || s < 130
  }

  /** 动态障碍物：可撞飞的油桶 / 轮胎堆 / 路锥 */
  private buildObstacles(density: number) {
    const barrelCount = Math.round(26 * density)
    const tireCount = Math.round(22 * density)
    const coneCount = Math.round(30 * density)

    const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 10)
    this.barrels = new THREE.InstancedMesh(
      barrelGeo,
      new THREE.MeshStandardMaterial({ color: 0xd94a2b, roughness: 0.6, metalness: 0.3, flatShading: true }),
      barrelCount
    )
    const tireGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.95, 10)
    this.tires = new THREE.InstancedMesh(
      tireGeo,
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.95, flatShading: true }),
      tireCount
    )
    const coneGeo = new THREE.ConeGeometry(0.36, 0.9, 7)
    coneGeo.translate(0, 0.45, 0)
    this.cones = new THREE.InstancedMesh(
      coneGeo,
      new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.7, flatShading: true }),
      coneCount
    )
    for (const m of [this.barrels, this.tires, this.cones]) {
      m.castShadow = true
      m.receiveShadow = true
      this.group.add(m)
    }

    const spawn = (
      count: number,
      type: DynObstacle['type'],
      radius: number,
      height: number,
      mass: number,
      lateralRange: [number, number]
    ) => {
      for (let i = 0; i < count; i++) {
        // 发车区（起跑线前后）留空：否则一起步就撞上油桶/轮胎堆，手感上跟“车开不动”一模一样
        let s = randomRange(0, this.track.length)
        for (let g = 0; g < 24 && this.inStartZone(s); g++) {
          s = randomRange(0, this.track.length)
        }
        const p = this.track.pointAtS(s)
        const idx = this.track.indexAtS(s)
        const right = this.track.rightAt(idx)
        const lateral = randomRange(lateralRange[0], lateralRange[1]) * (Math.random() < 0.5 ? -1 : 1)
        const pos = new THREE.Vector3(p.x + right.x * lateral, height, p.z + right.z * lateral)
        const heading = this.track.headingAtS(s) + randomRange(-0.6, 0.6)

        const shape =
          type === 'cone'
            ? new CANNON.Cylinder(0.05, 0.36, 0.9, 7)
            : new CANNON.Cylinder(radius, radius, height * 2, 10)
        const body = new CANNON.Body({
          mass,
          material: this.physics.materials.obstacle,
          shape,
        }) as SurfaceBody
        body.surfaceType = 'obstacle'
        body.position.set(pos.x, pos.y, pos.z)
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading)
        body.linearDamping = 0.35
        body.angularDamping = 0.4
        body.allowSleep = true
        body.sleepSpeedLimit = 0.4
        this.physics.world.addBody(body)
        this.dynamicObstacles.push({
          body,
          home: pos.clone(),
          homeQuat: body.quaternion.clone(),
          type,
        })
      }
    }

    spawn(barrelCount, 'barrel', 0.42, 0.55, 14, [3.5, 9])
    spawn(tireCount, 'tire', 0.62, 0.48, 22, [4, 10])
    spawn(coneCount, 'cone', 0.36, 0.45, 4, [2.5, 7])

    this.syncObstacles()
  }

  /** 跳台（静态上坡斜面，可飞跃） */
  private buildRamps() {
    const spots = [0.14, 0.36, 0.58, 0.8]
    const angle = 0.26
    spots.forEach((frac, k) => {
      const s = this.track.length * frac
      const p = this.track.pointAtS(s)
      const idx = this.track.indexAtS(s)
      const right = this.track.rightAt(idx)
      const heading = this.track.headingAtS(s)
      const lateral = k % 2 === 0 ? -4.2 : 4.2
      const cx = p.x + right.x * lateral
      const cz = p.z + right.z * lateral

      // Ry(heading) 后 local +Z 与赛道方向一致；再绕 local X 旋转 -angle 抬起远端
      const q = new CANNON.Quaternion()
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading)
      const tilt = new CANNON.Quaternion()
      tilt.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -angle)
      q.mult(tilt, q)

      const body = new CANNON.Body({
        mass: 0,
        material: this.physics.materials.road,
        shape: new CANNON.Box(new CANNON.Vec3(3.2, 0.4, 4.2)),
      }) as SurfaceBody
      body.surfaceType = 'road'
      body.position.set(cx, 0.7, cz)
      body.quaternion.copy(q)
      this.physics.world.addBody(body)

      const ramp = new THREE.Mesh(
        new THREE.BoxGeometry(6.4, 0.8, 8.4),
        new THREE.MeshStandardMaterial({ color: 0x394052, roughness: 0.8, flatShading: true })
      )
      ramp.position.set(cx, 0.7, cz)
      ramp.quaternion.set(q.x, q.y, q.z, q.w)
      ramp.castShadow = true
      ramp.receiveShadow = true
      this.group.add(ramp)

      // 两侧警示条
      for (const sx of [-3.3, 3.3]) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 1.0, 8.4),
          new THREE.MeshStandardMaterial({
            color: 0xffd166,
            emissive: 0xffa000,
            emissiveIntensity: 0.6,
          })
        )
        strip.position.set(cx + right.x * sx, 0.9, cz + right.z * sx)
        strip.rotation.y = heading
        this.group.add(strip)
      }
    })
  }

  // ------------------------------------------------------------------
  private syncObstacles() {
    const counts = { barrel: 0, tire: 0, cone: 0 }
    for (const o of this.dynamicObstacles) {
      const p = o.body.position
      const q = o.body.quaternion
      this.tmpPos.set(p.x, p.y, p.z)
      this.tmpQuat.set(q.x, q.y, q.z, q.w)
      this.matrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale)
      const target = o.type === 'barrel' ? this.barrels : o.type === 'tire' ? this.tires : this.cones
      const idx = counts[o.type]++
      if (idx < target.count) target.setMatrixAt(idx, this.matrix)
    }
    this.barrels.instanceMatrix.needsUpdate = true
    this.tires.instanceMatrix.needsUpdate = true
    this.cones.instanceMatrix.needsUpdate = true
  }

  update() {
    this.syncObstacles()
  }

  resetObstacles() {
    for (const o of this.dynamicObstacles) {
      o.body.position.set(o.home.x, o.home.y, o.home.z)
      o.body.quaternion.copy(o.homeQuat)
      o.body.velocity.setZero()
      o.body.angularVelocity.setZero()
      o.body.wakeUp()
    }
    this.syncObstacles()
  }
}
