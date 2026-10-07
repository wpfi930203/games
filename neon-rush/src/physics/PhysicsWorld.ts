import * as CANNON from 'cannon-es'

export type SurfaceType = 'road' | 'grass' | 'wall' | 'obstacle' | 'ground'

export type SurfaceBody = CANNON.Body & { surfaceType?: SurfaceType }

export interface PhysicsMaterials {
  ground: CANNON.Material
  road: CANNON.Material
  grass: CANNON.Material
  wall: CANNON.Material
  car: CANNON.Material
  obstacle: CANNON.Material
}

export class PhysicsWorld {
  world: CANNON.World
  materials: PhysicsMaterials
  /** 由调试面板控制 */
  gravity = -22
  fixedStep = 1 / 60

  constructor() {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, this.gravity, 0) })
    world.broadphase = new CANNON.SAPBroadphase(world)
    world.allowSleep = true
    world.defaultContactMaterial.friction = 0.35
    world.defaultContactMaterial.restitution = 0.15
    ;(world.solver as CANNON.GSSolver).iterations = 10

    const ground = new CANNON.Material('ground')
    const road = new CANNON.Material('road')
    const grass = new CANNON.Material('grass')
    const wall = new CANNON.Material('wall')
    const car = new CANNON.Material('car')
    const obstacle = new CANNON.Material('obstacle')

    // 车身 vs 护栏：有弹性 -> 撞击后反弹
    world.addContactMaterial(
      new CANNON.ContactMaterial(car, wall, { friction: 0.15, restitution: 0.55 })
    )
    // 车身 vs 障碍物：较重的碰撞反馈
    world.addContactMaterial(
      new CANNON.ContactMaterial(car, obstacle, { friction: 0.3, restitution: 0.35 })
    )
    world.addContactMaterial(
      new CANNON.ContactMaterial(car, car, { friction: 0.2, restitution: 0.4 })
    )
    world.addContactMaterial(
      new CANNON.ContactMaterial(car, ground, { friction: 0.45, restitution: 0.05 })
    )
    world.addContactMaterial(
      new CANNON.ContactMaterial(obstacle, ground, { friction: 0.6, restitution: 0.2 })
    )

    this.world = world
    this.materials = { ground, road, grass, wall, car, obstacle }

    this.patchAddBody()
    this.addGroundPlane()
  }

  /**
   * 【关键修复】cannon-es 的静态刚体 AABB 陷阱
   *
   * Body 构造时会调用 updateMassProperties()，它在**原点 + 无旋转**状态下算一次
   * AABB，并把 aabbNeedsUpdate 置为 false。我们随后设置 position / quaternion
   * 并不会重新标记，而静态刚体（mass=0）永远不会走 integrate()（只有 integrate
   * 会把 aabbNeedsUpdate 置回 true），于是它的 AABB 永久停留在原点。
   *
   * 后果：broadphase（SAP 排序 + aabbQuery）按错误 AABB 找候选体，
   * 车轮射线 castRay 一个都打不中 → 悬挂不生效、引擎力传不出去 → 车纹丝不动。
   * （出生点恰好在原点附近时又“正常”，所以问题会时有时无，极难定位。）
   *
   * 这里统一在 addBody 之后强制刷新 AABB，一劳永逸。
   */
  private patchAddBody() {
    const rawAddBody = this.world.addBody.bind(this.world)
    this.world.addBody = ((body: CANNON.Body) => {
      rawAddBody(body)
      body.aabbNeedsUpdate = true
      body.updateAABB()
    }) as typeof this.world.addBody
  }

  /** 手动移动静态刚体后调用，刷新其 AABB */
  refreshAABB(body: CANNON.Body) {
    body.aabbNeedsUpdate = true
    body.updateAABB()
  }

  /** 无限地面（RaycastVehicle 的轮子射线需要落到某个 body 上） */
  private addGroundPlane() {
    const body = new CANNON.Body({
      mass: 0,
      material: this.materials.ground,
      shape: new CANNON.Plane(),
    }) as SurfaceBody
    body.surfaceType = 'grass'
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2)
    this.world.addBody(body)
  }

  setGravity(g: number) {
    this.gravity = g
    this.world.gravity.set(0, g, 0)
  }

  step(dt: number) {
    this.world.step(this.fixedStep, dt, 5)
  }

  add(body: CANNON.Body) {
    this.world.addBody(body)
    return body
  }

  remove(body: CANNON.Body) {
    this.world.removeBody(body)
  }
}
