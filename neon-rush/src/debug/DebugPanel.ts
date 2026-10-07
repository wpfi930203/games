import { GUI } from 'dat.gui'
import * as THREE from 'three'
import type { Game } from '../core/Game'

/**
 * 实时物理 / 摄像机 / 环境调试面板（dat.gui）
 * 快捷键 G 打开
 */
export class DebugPanel {
  gui: GUI
  visible = false
  private game: Game

  constructor(game: Game) {
    this.game = game
    this.gui = new GUI({ width: 300 })
    const g = this.gui

    // ---------- 车辆物理 ----------
    const t = game.tuning
    const veh = g.addFolder('车辆物理 (Vehicle)')
    veh.add(t, 'engineForce', 500, 9000, 50).name('引擎推力 N')
    veh.add(t, 'nitroForce', 0, 6000, 50).name('氮气推力 N')
    veh.add(t, 'brakeForce', 5, 200, 1).name('刹车力')
    veh.add(t, 'handbrakeForce', 20, 500, 5).name('手刹力')
    veh.add(t, 'reverseForce', 200, 4000, 50).name('倒车推力')
    veh.add(t, 'topSpeed', 20, 140, 1).name('极速 m/s')
    veh.add(t, 'maxSteer', 0.1, 1.2, 0.01).name('最大转向 rad')

    const susp = g.addFolder('悬挂 / 轮胎 (Suspension)')
    susp.add(t, 'suspensionStiffness', 5, 90, 1).name('悬挂刚度')
    susp.add(t, 'suspensionRestLength', 0.1, 0.8, 0.01).name('悬挂长度')
    susp.add(t, 'dampingCompression', 0.5, 12, 0.1).name('压缩阻尼')
    susp.add(t, 'dampingRelaxation', 0.5, 12, 0.1).name('回弹阻尼')
    susp.add(t, 'maxSuspensionTravel', 0.05, 1, 0.01).name('最大行程')
    susp.add(t, 'frictionSlip', 0.5, 8, 0.1).name('轮胎抓地(路面)')
    susp.add(t, 'grassFriction', 0.3, 5, 0.1).name('轮胎抓地(草地)')
    susp.add(t, 'rollInfluence', 0, 0.3, 0.005).name('侧倾影响')
    susp.add(t, 'downforce', 0, 12, 0.1).name('下压力系数')
    susp.close()

    // ---------- 摄像机 ----------
    const cam = g.addFolder('摄像机 (Camera)')
    const c = game.rig.tuning
    cam.add(c, 'distance', 3, 30, 0.2).name('距离')
    cam.add(c, 'height', 0.5, 15, 0.1).name('高度')
    cam.add(c, 'lookAhead', 0, 40, 0.5).name('前视距离')
    cam.add(c, 'damping', 1, 20, 0.2).name('跟随阻尼')
    cam.add(c, 'fov', 35, 110, 1).name('基础 FOV')
    cam.add(c, 'speedFov', 0, 40, 1).name('速度 FOV 增益')
    cam.add(game.rig, 'mode', ['chase', 'hood', 'far', 'top']).name('视角')
    cam.close()

    // ---------- 环境 ----------
    const env = g.addFolder('环境 (Environment)')
    const e = game.environment
    env.add(e, 'timeOfDay', 0, 24, 0.1).name('时间 (小时)')
    env.add(e, 'cycleEnabled').name('昼夜循环')
    env.add(e, 'cycleSpeed', 0, 5, 0.05).name('循环速度')
    env
      .add(e, 'weather', ['clear', 'rain', 'snow', 'fog'])
      .name('天气')
      .onChange((v: string) => e.setWeather(v as 'clear'))
    env.add(e, 'autoWeather').name('随机天气')
    env.close()

    // ---------- 世界物理 ----------
    const phys = g.addFolder('世界 (Physics)')
    const p = { gravity: game.physics.gravity, iterations: 10 }
    phys
      .add(p, 'gravity', -60, -2, 0.5)
      .name('重力')
      .onChange((v: number) => game.physics.setGravity(v))
    phys.add(p, 'iterations', 1, 30, 1).name('求解迭代').onChange((v: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(game.physics.world.solver as any).iterations = v
    })
    phys.close()

    // ---------- 显示 / 操作 ----------
    const act = g.addFolder('显示 / 操作 (Debug)')
    act.add(game, 'showFps').name('显示 FPS')
    const flags = {
      wireframe: false,
      shadows: true,
      resetCar: () => game.mode?.respawnPlayer(),
      resetObstacles: () => game.scenery.resetObstacles(),
      flipUpright: () => game.mode?.player.respawnUpright(),
      boostNitro: () => {
        if (game.mode) game.mode.player.nitroAmount = game.mode.player.tuning.nitroCapacity
      },
    }
    act
      .add(flags, 'wireframe')
      .name('线框')
      .onChange((v: boolean) => {
        game.scene.traverse((o) => {
          const m = o as THREE.Mesh
          const mat = m.material as THREE.Material | THREE.Material[] | undefined
          if (!mat) return
          const list = Array.isArray(mat) ? mat : [mat]
          for (const mm of list) {
            if ('wireframe' in mm) (mm as THREE.MeshStandardMaterial).wireframe = v
          }
        })
      })
    act
      .add(flags, 'shadows')
      .name('阴影')
      .onChange((v: boolean) => {
        game.renderer.shadowMap.enabled = v
        game.scene.traverse((o) => {
          if ((o as THREE.Mesh).material) {
            const m = (o as THREE.Mesh).material as THREE.Material
            m.needsUpdate = true
          }
        })
      })
    act.add(flags, 'flipUpright').name('扶正车辆')
    act.add(flags, 'resetCar').name('回到赛道')
    act.add(flags, 'resetObstacles').name('复位障碍物')
    act.add(flags, 'boostNitro').name('充满氮气')
    act.close()

    this.setVisible(false)
  }

  toggle() {
    this.setVisible(!this.visible)
  }

  setVisible(v: boolean) {
    this.visible = v
    this.gui.domElement.style.display = v ? '' : 'none'
  }

  /** 每帧：让手动修改的时间/天气生效 */
  update() {
    if (!this.visible) return
    if (!this.game.environment.cycleEnabled) {
      this.game.environment.setTimeOfDay(this.game.environment.timeOfDay)
    }
  }
}
