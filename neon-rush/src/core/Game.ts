import * as THREE from 'three'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { Track, buildTrack } from '../world/Track'
import { Scenery } from '../world/Scenery'
import { Environment } from '../world/Environment'
import { Effects } from '../fx/Effects'
import { CameraRig } from '../camera/CameraRig'
import { HUD } from '../ui/HUD'
import { Minimap } from '../ui/Minimap'
import { TouchControls, isTouchDevice } from '../ui/TouchControls'
import { InputManager } from './Input'
import { AudioManager } from './AudioManager'
import { DebugPanel } from '../debug/DebugPanel'
import { RaceMode } from '../modes/RaceMode'
import { TimeTrialMode } from '../modes/TimeTrialMode'
import { ArenaMode } from '../modes/ArenaMode'
import { GameMode, type ModeContext } from '../modes/Mode'
import { defaultTuning, grip, type VehicleTuning } from '../vehicle/Vehicle'
import { clamp } from '../utils/math'

export type GameState = 'menu' | 'racing' | 'paused' | 'finished'
export type ModeId = 'race' | 'timetrial' | 'arena'

const CAR_COLORS = [
  0x37f5d8, 0xff2d75, 0xffd166, 0x7af7ff, 0x9b7bff, 0x4dff9e, 0xff7a1a, 0xe8edf2,
]

export class Game {
  renderer!: THREE.WebGLRenderer
  scene!: THREE.Scene
  camera!: THREE.PerspectiveCamera
  rig!: CameraRig
  physics!: PhysicsWorld
  track!: Track
  scenery!: Scenery
  environment!: Environment
  effects!: Effects
  hud!: HUD
  minimap!: Minimap
  input!: InputManager
  touch!: TouchControls
  audio = new AudioManager()
  debug!: DebugPanel

  mode: GameMode | null = null
  state: GameState = 'menu'
  modeId: ModeId = 'race'
  quality: 'low' | 'high' = 'high'
  playerColor = CAR_COLORS[0]
  tuning: VehicleTuning = { ...defaultTuning }
  showFps = false

  private clockLast = 0
  private fpsAcc = 0
  private fpsFrames = 0
  private fpsValue = 0
  private introTime = 0
  private modeContext!: ModeContext

  constructor(private canvas: HTMLCanvasElement) {}

  async init() {
    const isMobile = isTouchDevice() || window.innerWidth < 820
    this.quality = isMobile ? 'low' : 'high'

    // ---------- 渲染器 ----------
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality === 'high',
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality === 'high' ? 2 : 1.5))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 2200)
    this.camera.position.set(0, 8, -16)
    this.rig = new CameraRig(this.camera)

    // ---------- 系统 ----------
    this.physics = new PhysicsWorld()
    this.effects = new Effects(this.scene, this.quality)
    this.environment = new Environment(this.scene, this.quality)
    this.hud = new HUD()
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement)
    this.input = new InputManager()
    this.touch = new TouchControls(this.input)
    this.touch.setVisible(isTouchDevice())

    // ---------- 世界 ----------
    this.track = new Track()
    buildTrack(this.scene, this.physics, this.track, { barriers: true })
    this.scenery = new Scenery(this.scene, this.physics, this.track, this.quality)
    this.minimap.setTrack(this.track)

    this.modeContext = {
      scene: this.scene,
      physics: this.physics,
      track: this.track,
      effects: this.effects,
      environment: this.environment,
      hud: this.hud,
      minimap: this.minimap,
      audio: this.audio,
      input: this.input,
      camera: this.rig,
      quality: this.quality,
      playerColor: this.playerColor,
      vibrate: (p) => this.vibrate(p),
      finish: (title, rows) => this.showResults(title, rows),
      tuning: this.tuning,
    }

    this.debug = new DebugPanel(this)

    // ---------- 菜单 ----------
    this.bindMenu()

    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'racing') this.pause()
    })
    // 首次交互解锁音频
    const unlock = () => {
      this.audio.start()
      this.audio.resume()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)

    // 菜单背景：沿赛道缓慢巡游的镜头
    this.camera.position.set(
      this.track.points[0].x - 40,
      26,
      this.track.points[0].z - 40
    )
    this.camera.lookAt(this.track.points[0])

    this.clockLast = performance.now()
    requestAnimationFrame(this.loop)
  }

  // ------------------------------------------------------------------
  private bindMenu() {
    const cards = document.querySelectorAll<HTMLElement>('.mode-card')
    cards.forEach((c) =>
      c.addEventListener('click', () => {
        cards.forEach((x) => x.classList.remove('selected'))
        c.classList.add('selected')
        this.modeId = c.dataset.mode as ModeId
      })
    )

    const picker = document.getElementById('color-picker')!
    CAR_COLORS.forEach((c, i) => {
      const el = document.createElement('div')
      el.className = 'swatch' + (i === 0 ? ' selected' : '')
      el.style.background = '#' + new THREE.Color(c).getHexString()
      el.style.color = '#' + new THREE.Color(c).getHexString()
      el.addEventListener('click', () => {
        document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'))
        el.classList.add('selected')
        this.playerColor = c
        this.modeContext.playerColor = c
        this.mode?.player.setColor?.(c)
      })
      picker.appendChild(el)
    })

    document.getElementById('btn-start')!.addEventListener('click', () => {
      const night = (document.getElementById('opt-night') as HTMLInputElement).checked
      const weather = (document.getElementById('opt-weather') as HTMLInputElement).checked
      const sound = (document.getElementById('opt-sound') as HTMLInputElement).checked
      const dbg = (document.getElementById('opt-debug') as HTMLInputElement).checked
      this.environment.cycleEnabled = night
      this.environment.autoWeather = weather
      this.audio.setEnabled(sound)
      this.debug.setVisible(dbg)
      this.startMode(this.modeId)
    })

    document.getElementById('btn-again')!.addEventListener('click', () => {
      document.getElementById('results')!.classList.add('hidden')
      this.startMode(this.modeId)
    })
    document.getElementById('btn-menu')!.addEventListener('click', () => {
      document.getElementById('results')!.classList.add('hidden')
      this.toMenu()
    })
    document.getElementById('btn-resume')!.addEventListener('click', () => this.resume())
    document.getElementById('btn-quit')!.addEventListener('click', () => {
      document.getElementById('pause')!.classList.add('hidden')
      this.toMenu()
    })
  }

  // ------------------------------------------------------------------
  startMode(id: ModeId) {
    this.disposeMode()
    this.modeId = id
    this.modeContext.playerColor = this.playerColor
    this.modeContext.tuning = this.tuning

    switch (id) {
      case 'timetrial':
        this.mode = new TimeTrialMode(this.modeContext)
        break
      case 'arena':
        this.mode = new ArenaMode(this.modeContext)
        break
      default:
        this.mode = new RaceMode(this.modeContext)
        break
    }
    this.mode.onEnter()
    this.introTime = 0
    this.state = 'racing'
    document.getElementById('menu')!.classList.add('hidden')
    document.getElementById('results')!.classList.add('hidden')
    this.hud.setVisible(true)
    this.scenery.resetObstacles()
    this.effects.clear()
    this.rig.setMode('chase')
    this.rig.snap(this.mode.player)
    this.audio.start()
    this.audio.resume()
  }

  private disposeMode() {
    if (this.mode) {
      this.mode.dispose()
      this.mode = null
    }
  }

  toMenu() {
    this.disposeMode()
    this.state = 'menu'
    this.hud.setVisible(false)
    this.hud.setWrongWay(false)
    document.getElementById('menu')!.classList.remove('hidden')
    document.getElementById('pause')!.classList.add('hidden')
  }

  pause() {
    if (this.state !== 'racing') return
    this.state = 'paused'
    document.getElementById('pause')!.classList.remove('hidden')
    this.input.enabled = false
  }

  resume() {
    if (this.state !== 'paused') return
    this.state = 'racing'
    document.getElementById('pause')!.classList.add('hidden')
    this.input.enabled = true
    this.clockLast = performance.now()
  }

  showResults(title: string, rows: string[]) {
    this.state = 'finished'
    const el = document.getElementById('results')!
    document.getElementById('res-title')!.textContent = title
    document.getElementById('res-body')!.innerHTML = rows.join('')
    el.classList.remove('hidden')
    this.hud.setVisible(false)
  }

  vibrate(pattern: number | number[]) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern)
      } catch {
        /* 忽略 */
      }
    }
  }

  // ------------------------------------------------------------------
  private onResize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality === 'high' ? 2 : 1.5))
  }

  private handleGlobalKeys() {
    if (this.input.pausePressed) {
      this.input.pausePressed = false
      if (this.state === 'racing') this.pause()
      else if (this.state === 'paused') this.resume()
    }
    if (this.input.debugToggle) {
      this.input.debugToggle = false
      this.debug.toggle()
    }
    if (this.input.muteToggle) {
      this.input.muteToggle = false
      this.audio.setEnabled(!this.audio.enabled)
      this.hud.toast(this.audio.enabled ? '音效开' : '音效关', 1.2)
    }
    if (this.input.cameraToggle) {
      this.input.cameraToggle = false
      const m = this.rig.cycle()
      const names: Record<string, string> = {
        chase: '追尾视角',
        hood: '车头视角',
        far: '远景视角',
        top: '俯视视角',
      }
      this.hud.toast(names[m] ?? m, 1.2)
    }
    if (this.input.respawnPressed) {
      this.input.respawnPressed = false
      this.mode?.respawnPlayer()
    }
  }

  private menuCamera(dt: number) {
    // 沿赛道缓慢移动的展示镜头
    this.introTime += dt * 0.035
    const s = (this.introTime % 1) * this.track.length
    const p = this.track.pointAtS(s)
    const next = this.track.pointAtS(s + 30)
    this.camera.position.lerp(
      new THREE.Vector3(p.x, 22, p.z),
      1 - Math.exp(-1.5 * dt)
    )
    this.camera.lookAt(next.x, 1, next.z)
    this.camera.fov = 58
    this.camera.updateProjectionMatrix()
  }

  private loop = (now: number) => {
    requestAnimationFrame(this.loop)
    const rawDt = (now - this.clockLast) / 1000
    this.clockLast = now
    const dt = clamp(rawDt, 0, 0.05)

    // FPS
    this.fpsAcc += rawDt
    this.fpsFrames++
    if (this.fpsAcc >= 0.5) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsAcc)
      this.fpsAcc = 0
      this.fpsFrames = 0
      this.hud.setFps(this.fpsValue, this.showFps)
    }

    this.handleGlobalKeys()

    if (this.state === 'menu') {
      this.menuCamera(dt)
      this.physics.step(dt)
      this.scenery.update()
      this.environment.update(dt, this.camera.position)
      this.effects.update(dt)
      this.renderer.render(this.scene, this.camera)
      return
    }

    const mode = this.mode
    if (!mode) return

    if (this.state === 'racing') {
      const playerInput = this.input.sample(dt)
      mode.update(dt, playerInput)

      // 天气 -> 抓地力
      grip.weather = this.environment.weatherGrip

      this.physics.step(dt)
      for (const v of mode.vehicles) v.postStep()
      this.scenery.update()

      // 氮气尾焰
      const pv = mode.player
      if (pv.nitroActive) {
        const fwd = pv.forwardVector()
        this.effects.boostFlame(
          pv.mesh.group.position.clone().addScaledVector(fwd, -2.3).setY(pv.mesh.group.position.y + 0.1),
          fwd.clone().multiplyScalar(-1),
          1
        )
      }

      // 摄像机
      if (mode.countdown > 0) {
        this.rig.orbitIntro(dt, pv, 1 - mode.countdown / 3.2)
      } else {
        this.rig.update(dt, pv)
      }

      // 音频
      this.audio.update(
        pv.getRpm01(),
        clamp(pv.speedKmh / 220, 0, 1),
        pv.nitroActive,
        true
      )

      // HUD
      const data = mode.hudData()
      this.hud.update(dt, data)
      this.hud.setWrongWay(this.wrongWay())
      this.minimap.draw(mode.minimapDots())
      this.environment.followTarget(pv.mesh.group.position)
    } else {
      this.audio.update(0, 0, false, false)
    }

    this.environment.update(dt, this.camera.position)
    this.effects.update(dt)
    this.debug.update()
    this.renderer.render(this.scene, this.camera)
  }

  private wrongWay(): boolean {
    const mode = this.mode
    if (!mode || !('racers' in mode)) return false
    const racers = (mode as unknown as { racers: { isPlayer: boolean; wrongWay: boolean }[] }).racers
    const me = racers.find((r) => r.isPlayer)
    return !!me?.wrongWay
  }
}
