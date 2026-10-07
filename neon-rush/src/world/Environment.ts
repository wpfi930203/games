import * as THREE from 'three'
import { clamp, lerp } from '../utils/math'

export type Weather = 'clear' | 'rain' | 'snow' | 'fog'

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const SKY_FRAG = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
uniform vec3 sunColor;
uniform vec3 sunDir;
uniform float sunPower;
varying vec3 vWorld;

void main() {
  vec3 dir = normalize(vWorld);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(bottomColor, horizonColor, smoothstep(0.35, 0.5, h));
  col = mix(col, topColor, smoothstep(0.5, 0.95, h));
  float sun = pow(max(dot(dir, normalize(sunDir)), 0.0), 220.0);
  float glow = pow(max(dot(dir, normalize(sunDir)), 0.0), 8.0) * sunPower;
  col += sunColor * (sun * 2.0 + glow * 0.35);
  gl_FragColor = vec4(col, 1.0);
}
`

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (320.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`

const PARTICLE_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = smoothstep(0.25, 0.02, d) * vAlpha;
  gl_FragColor = vec4(vColor, a);
}
`

export class Environment {
  scene: THREE.Scene
  sun: THREE.DirectionalLight
  moon: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  sky: THREE.Mesh
  stars: THREE.Points
  sunDisc: THREE.Mesh
  moonDisc: THREE.Mesh

  timeOfDay = 14.2
  cycleEnabled = true
  cycleSpeed = 0.35 // 小时 / 秒
  weather: Weather = 'clear'
  autoWeather = false
  private weatherTimer = 0

  private rain!: THREE.LineSegments
  private rainData!: Float32Array
  private snow!: THREE.Points
  private snowData!: Float32Array
  private snowPhase!: Float32Array

  private sunDir = new THREE.Vector3()
  private tmp = new THREE.Vector3()
  weatherGrip = 1
  fogDensity = 0

  constructor(scene: THREE.Scene, quality: 'low' | 'high' = 'high') {
    this.scene = scene

    // ---- 天空 ----
    const skyGeo = new THREE.SphereGeometry(900, 24, 16)
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x1b4b8f) },
        horizonColor: { value: new THREE.Color(0xf0a868) },
        bottomColor: { value: new THREE.Color(0x2a2436) },
        sunColor: { value: new THREE.Color(0xffd7a0) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunPower: { value: 1 },
      },
    })
    this.sky = new THREE.Mesh(skyGeo, skyMat)
    this.sky.frustumCulled = false
    scene.add(this.sky)

    // ---- 光照 ----
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 400
    const S = 110
    this.sun.shadow.camera.left = -S
    this.sun.shadow.camera.right = S
    this.sun.shadow.camera.top = S
    this.sun.shadow.camera.bottom = -S
    this.sun.shadow.bias = -0.0012
    this.sun.shadow.normalBias = 0.035
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.moon = new THREE.DirectionalLight(0x8fb6ff, 0.0)
    scene.add(this.moon)
    scene.add(this.moon.target)

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x2b3a2a, 0.55)
    scene.add(this.hemi)

    // ---- 太阳 / 月亮圆盘 ----
    const discMat = (color: number) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(28, 24), discMat(0xffe9b0))
    this.sunDisc.frustumCulled = false
    scene.add(this.sunDisc)
    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(18, 20), discMat(0xdce8ff))
    this.moonDisc.frustumCulled = false
    scene.add(this.moonDisc)

    // ---- 星空 ----
    const starCount = quality === 'high' ? 900 : 400
    const sPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const u = Math.random() * Math.PI * 2
      const v = Math.acos(2 * Math.random() - 1)
      const r = 800
      sPos[i * 3] = Math.sin(v) * Math.cos(u) * r
      sPos[i * 3 + 1] = Math.abs(Math.cos(v)) * r * 0.9 + 20
      sPos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * r
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3))
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0 })
    )
    this.stars.frustumCulled = false
    scene.add(this.stars)

    // ---- 雨 / 雪 ----
    this.buildPrecipitation(quality)

    scene.fog = new THREE.Fog(0xa9c7e6, 90, 520)
    this.applyTimeOfDay()
    this.setWeather('clear')
  }

  private buildPrecipitation(quality: 'low' | 'high') {
    const rainCount = quality === 'high' ? 1400 : 600
    const geo = new THREE.BufferGeometry()
    this.rainData = new Float32Array(rainCount * 6)
    for (let i = 0; i < rainCount; i++) {
      const x = (Math.random() - 0.5) * 120
      const y = Math.random() * 70 - 10
      const z = (Math.random() - 0.5) * 120
      const len = 1.6 + Math.random() * 1.6
      this.rainData.set([x, y, z, x + 0.25, y - len, z], i * 6)
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.rainData, 3))
    this.rain = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xa9d4ff, transparent: true, opacity: 0.5 })
    )
    this.rain.frustumCulled = false
    this.rain.visible = false
    this.scene.add(this.rain)

    const snowCount = quality === 'high' ? 1600 : 700
    const sgeo = new THREE.BufferGeometry()
    this.snowData = new Float32Array(snowCount * 3)
    this.snowPhase = new Float32Array(snowCount)
    for (let i = 0; i < snowCount; i++) {
      this.snowData[i * 3] = (Math.random() - 0.5) * 120
      this.snowData[i * 3 + 1] = Math.random() * 70 - 10
      this.snowData[i * 3 + 2] = (Math.random() - 0.5) * 120
      this.snowPhase[i] = Math.random() * Math.PI * 2
    }
    sgeo.setAttribute('position', new THREE.BufferAttribute(this.snowData, 3))
    const sizes = new Float32Array(snowCount).fill(2.4)
    sgeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    sgeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(snowCount).fill(0.9), 1))
    sgeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(snowCount * 3).fill(1), 3))
    this.snow = new THREE.Points(
      sgeo,
      new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
      })
    )
    this.snow.frustumCulled = false
    this.snow.visible = false
    this.scene.add(this.snow)
  }

  setTimeOfDay(t: number) {
    this.timeOfDay = ((t % 24) + 24) % 24
    this.applyTimeOfDay()
  }

  setWeather(w: Weather) {
    this.weather = w
    this.rain.visible = w === 'rain'
    this.snow.visible = w === 'snow'
    this.weatherGrip = w === 'rain' ? 0.72 : w === 'snow' ? 0.58 : w === 'fog' ? 0.88 : 1
  }

  private applyTimeOfDay() {
    const t = this.timeOfDay
    // 日出 6 点，日落 19 点
    const angle = ((t - 6) / 24) * Math.PI * 2
    this.sunDir.set(Math.cos(angle) * 0.6, Math.sin(angle), Math.cos(angle) * 0.35 + 0.25).normalize()

    const dayFactor = clamp(Math.sin(((t - 6) / 24) * Math.PI * 2) * 1.6 + 0.35, 0, 1)
    const sunset = clamp(1 - Math.abs(t - 18.2) / 2.2, 0, 1)
    const night = 1 - dayFactor

    const u = this.sky.material as THREE.ShaderMaterial
    const dayTop = new THREE.Color(0x2b6fd6)
    const dayHorizon = new THREE.Color(0xa9d0f5)
    const duskTop = new THREE.Color(0x2a2c63)
    const duskHorizon = new THREE.Color(0xff8d4d)
    const nightTop = new THREE.Color(0x060a1a)
    const nightHorizon = new THREE.Color(0x14203c)

    const top = nightTop.clone().lerp(dayTop, dayFactor).lerp(duskTop, sunset * 0.75)
    const horizon = nightHorizon.clone().lerp(dayHorizon, dayFactor).lerp(duskHorizon, sunset)
    const bottom = top.clone().multiplyScalar(0.55)

    u.uniforms.topColor.value.copy(top)
    u.uniforms.horizonColor.value.copy(horizon)
    u.uniforms.bottomColor.value.copy(bottom)
    u.uniforms.sunDir.value.copy(this.sunDir)
    u.uniforms.sunColor.value.setHex(sunset > 0.5 ? 0xff9052 : 0xffe4b5)
    u.uniforms.sunPower.value = lerp(0.15, 1, dayFactor)

    this.sun.intensity = lerp(0.05, 2.6, dayFactor)
    this.sun.color.setHex(sunset > 0.4 ? 0xffb066 : 0xfff0d0)
    this.moon.intensity = night * 0.55
    this.hemi.intensity = lerp(0.34, 0.75, dayFactor)
    this.hemi.color.setHex(sunset > 0.4 ? 0xff9f6b : 0xbfd8ff)

    ;(this.stars.material as THREE.PointsMaterial).opacity = clamp(night * 1.1 - 0.1, 0, 1)
    this.sunDisc.visible = dayFactor > 0.06
    this.moonDisc.visible = night > 0.15
    ;(this.sunDisc.material as THREE.MeshBasicMaterial).opacity = clamp(dayFactor * 1.3, 0, 0.95)
    ;(this.moonDisc.material as THREE.MeshBasicMaterial).opacity = clamp(night * 1.2, 0, 0.9)

    const fogColor = horizon.clone().lerp(new THREE.Color(0x0b1020), night * 0.6)
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(fogColor)
  }

  /** 阴影相机跟随玩家 */
  followTarget(pos: THREE.Vector3) {
    this.sun.position.copy(pos).addScaledVector(this.sunDir, 160)
    this.sun.target.position.copy(pos)
    this.sun.target.updateMatrixWorld()
    this.moon.position.copy(pos).addScaledVector(this.sunDir, -160)
    this.moon.target.position.copy(pos)
  }

  update(dt: number, cameraPos: THREE.Vector3) {
    if (this.cycleEnabled) {
      this.timeOfDay = (this.timeOfDay + dt * this.cycleSpeed * 0.06) % 24
      this.applyTimeOfDay()
    }
    if (this.autoWeather) {
      this.weatherTimer -= dt
      if (this.weatherTimer <= 0) {
        this.weatherTimer = 25 + Math.random() * 40
        const options: Weather[] = ['clear', 'clear', 'rain', 'snow', 'fog']
        this.setWeather(options[Math.floor(Math.random() * options.length)])
      }
    }

    // 天气对雾的影响
    const fog = this.scene.fog as THREE.Fog
    if (fog) {
      const target =
        this.weather === 'fog' ? { near: 18, far: 150 } : this.weather === 'rain' || this.weather === 'snow' ? { near: 45, far: 300 } : { near: 90, far: 560 }
      fog.near = lerp(fog.near, target.near, 1 - Math.exp(-1.5 * dt))
      fog.far = lerp(fog.far, target.far, 1 - Math.exp(-1.5 * dt))
    }

    // 天体跟随相机
    this.sky.position.set(cameraPos.x, 0, cameraPos.z)
    this.stars.position.set(cameraPos.x, 0, cameraPos.z)
    this.tmp.copy(this.sunDir).multiplyScalar(650).add(cameraPos)
    this.sunDisc.position.copy(this.tmp)
    this.sunDisc.lookAt(cameraPos)
    this.tmp.copy(this.sunDir).multiplyScalar(-650).add(cameraPos)
    this.moonDisc.position.copy(this.tmp)
    this.moonDisc.lookAt(cameraPos)

    // 降水
    if (this.rain.visible) {
      const arr = this.rainData
      const fall = 62 * dt
      for (let i = 0; i < arr.length; i += 6) {
        arr[i + 1] -= fall
        arr[i + 4] -= fall
        if (arr[i + 1] < -14) {
          const ny = Math.random() * 20 + 50
          const x = (Math.random() - 0.5) * 120
          const z = (Math.random() - 0.5) * 120
          const len = arr[i + 1] - arr[i + 4]
          arr[i] = x
          arr[i + 1] = ny
          arr[i + 2] = z
          arr[i + 3] = x + 0.25
          arr[i + 4] = ny - len
          arr[i + 5] = z
        }
      }
      ;(this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      this.rain.position.set(cameraPos.x, cameraPos.y, cameraPos.z)
    }
    if (this.snow.visible) {
      const arr = this.snowData
      const t = performance.now() * 0.001
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] -= 7 * dt
        arr[i] += Math.sin(t + this.snowPhase[i / 3]) * 2.2 * dt
        if (arr[i + 1] < -10) {
          arr[i] = (Math.random() - 0.5) * 120
          arr[i + 1] = Math.random() * 20 + 50
          arr[i + 2] = (Math.random() - 0.5) * 120
        }
      }
      ;(this.snow.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      this.snow.position.set(cameraPos.x, cameraPos.y, cameraPos.z)
    }
  }
}
