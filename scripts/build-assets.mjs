import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const assets = fileURLToPath(new URL('../src/assets/', import.meta.url))
const browser = await chromium.launch()

try {
  for (const name of ['cursor', 'click-pulse']) {
    const svg = await readFile(`${assets}${name}.svg`, 'utf8')
    const width = Number(svg.match(/width="(\d+)"/)[1])
    const height = Number(svg.match(/height="(\d+)"/)[1])
    for (const scale of [1, 2]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
      await page.setContent(`<style>html, body { margin: 0; background: transparent } svg { display: block }</style>${svg}`)
      await writeFile(`${assets}${name}-${scale}x.png`, await page.screenshot({ omitBackground: true }))
      await page.close()
    }
  }
} finally {
  await browser.close()
}
