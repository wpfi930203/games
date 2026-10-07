import './styles.css'
import { Game } from './core/Game'
import { BUILD_TAG } from './version'

// 版本水印：确认当前运行的是哪一版构建（修 bug 后靠它判断文件是否已更新）
const stamp = document.getElementById('build-stamp')
if (stamp) {
  stamp.textContent = BUILD_TAG
  stamp.classList.add('ok')
}
// 便于自动化测试核对版本
;(window as unknown as { BUILD_TAG: string }).BUILD_TAG = BUILD_TAG

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement
const loading = document.getElementById('loading') as HTMLElement
const loadingText = document.getElementById('loading-text') as HTMLElement

const game = new Game(canvas)

// 先让浏览器绘制一次加载界面，再执行较重的构建
requestAnimationFrame(() => {
  game
    .init()
    .then(() => {
      loadingText.textContent = '准备就绪'
      loading.classList.add('hidden')
    })
    .catch((err: unknown) => {
      console.error(err)
      loadingText.textContent = '初始化失败：' + (err instanceof Error ? err.message : String(err))
    })
})

// 阻止移动端默认手势（双击缩放 / 滚动）
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault()
  },
  { passive: false }
)
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('contextmenu', (e) => e.preventDefault())

// 便于调试
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).game = game

/**
 * 自动化冒烟测试：仅在 URL 带 ?smoke 时启用（供无头浏览器测试）。
 * 依次进入三个模式，读取运行状态并通过 console.log 输出。
 */
async function smokeTest() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const errors: string[] = []
  window.addEventListener('error', (e) => errors.push(String(e.message)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = () => (window as any).game

  await sleep(1500)
  console.log('[SMOKE] init state =', g()?.state)

  const press = (code: string, down: boolean) =>
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }))

  for (const mode of ['race', 'timetrial', 'arena']) {
    document.querySelectorAll<HTMLElement>('.mode-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.mode === mode)
    })
    g().modeId = mode
    document.getElementById('btn-start')?.click()
    await sleep(5000)
    press('KeyW', true)
    press('KeyA', true)
    await sleep(5000)
    press('KeyW', false)
    press('KeyA', false)
    const gm = g()?.mode
    const p = gm?.player?.mesh?.group?.position
    console.log(
      '[SMOKE]',
      JSON.stringify({
        mode,
        state: g()?.state,
        speed: Math.round(gm?.player?.speedKmh ?? -1),
        grounded: gm?.player?.groundedWheels,
        pos: p ? [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)].join(',') : 'n/a',
        vehicles: gm?.vehicles?.length ?? -1,
        fps: g()?.fpsValue,
      })
    )
    g().toMenu()
    await sleep(800)
  }
  console.log('[SMOKE] errors:', errors.length ? errors.join(' | ') : 'none')
  console.log('[SMOKE] done')
}

if (location.search.includes('smoke')) {
  smokeTest()
}
