/**
 * 生成单文件版游戏：把 JS / CSS 全部内联进一个 HTML，
 * 双击即可玩（无需服务器）。
 * 用法：npm run build && node scripts/build-standalone.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')

let html = readFileSync(join(dist, 'index.html'), 'utf8')

// 找到打包产物
const assets = readdirSync(join(dist, 'assets'))
const js = assets.find((f) => f.endsWith('.js'))
const css = assets.find((f) => f.endsWith('.css'))
if (!js || !css) throw new Error('dist/assets 中缺少 js/css 产物，请先执行 npm run build')

const jsCode = readFileSync(join(dist, 'assets', js), 'utf8')
  // 防止内联时提前闭合 script 标签（<\/script> 与 </script> 在 JS 字符串/正则中语义相同）
  .replace(/<\/script>/g, '<\\/script>')
const cssCode = readFileSync(join(dist, 'assets', css), 'utf8')

html = html.replace(
  /<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/,
  () => `<script type="module">\n${jsCode}\n</script>`
)
html = html.replace(
  /<link rel="stylesheet"[^>]*href="[^"]*"[^>]*>/,
  () => `<style>\n${cssCode}\n</style>`
)

const out = join(root, 'NEON-RUSH-单文件版.html')
writeFileSync(out, html)
console.log('✓ 已生成单文件版:', out, `(${(html.length / 1024).toFixed(0)} KB)`)
