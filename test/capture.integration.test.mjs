import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { captureFlow } from '../src/capture.mjs'
import { createConfig } from '../src/config.mjs'
import { runCommand } from '../src/ffmpeg.mjs'
import { loadFlow } from '../src/flow.mjs'

test('flow actions keep the normal timeout after a short ready timeout', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-capture-'))
  try {
    const page = join(directory, 'page.html')
    const flowPath = join(directory, 'flow.mjs')
    await writeFile(page, '<p>Ready</p>')
    await writeFile(flowPath, `export default async ({ page }) => {
  await page.evaluate(() => setTimeout(() => document.body.innerHTML = '<button>Late</button>', 1500))
  await page.getByRole('button', { name: 'Late' }).waitFor()
}
`)
    const config = createConfig({ url: pathToFileURL(page).href, flow: flowPath, preset: 'draft', readyTimeout: 1, postRoll: 0 })

    const { trace } = await captureFlow({ config, flow: await loadFlow(flowPath, config.viewport), directory })

    assert.ok(trace.end >= 1.5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a viewport change during the flow stops capture with CAPTURE_SIZE_CHANGED', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-resize-'))
  try {
    const page = join(directory, 'page.html')
    const flowPath = join(directory, 'flow.mjs')
    await writeFile(page, '<p>Resize</p>')
    await writeFile(flowPath, `export let resizedAt
export default async ({ page, wait }) => {
  await wait(0.3)
  await page.setViewportSize({ width: 300, height: 180 })
  resizedAt = performance.now()
  await wait(30)
}
`)
    const config = createConfig({ url: pathToFileURL(page).href, flow: flowPath, viewportWidth: 320, viewportHeight: 200, scale: 1, fps: 30, postRoll: 0, flowTimeout: 45, runDirectory: directory })

    await assert.rejects(captureFlow({ config, flow: await loadFlow(flowPath, config.viewport), directory }), error => {
      assert.equal(error.code, 'CAPTURE_SIZE_CHANGED')
      // Chromium can first deliver the new viewport scaled to the old picture width (here 320×192), then the new size.
      assert.match(error.message, /from 320×200 for a 320×200 viewport to \d+×\d+ for a 300×180 viewport/)
      assert.equal(error.diagnostics.screenshotPath, join(directory, 'failure.png'))
      return true
    })
    // Stopped by the first resized frame, not by the flow's 30-second wait.
    const { resizedAt } = await import(pathToFileURL(flowPath).href)
    assert.ok(performance.now() - resizedAt < 10_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// The default headless shell used to size DOM fullscreen from its 800×600 window.
const enterFullscreen = `await page.getByRole('button', { name: 'Fullscreen' }).click()
  await page.waitForFunction(() => document.fullscreenElement)`
for (const [scale, when] of [[1, 'ready'], [2, 'ready'], [2, 'flow']]) {
  test(`DOM fullscreen ${when === 'ready' ? 'before' : 'during'} capture keeps ${scale}× frames at the viewport size`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traceframe-fullscreen-'))
    try {
      const page = join(directory, 'page.html')
      const flowPath = join(directory, 'flow.mjs')
      await writeFile(page, `<style>body{margin:0}#stage{width:120px;height:80px;background:#246}</style>
<div id="stage"></div><button onclick="document.getElementById('stage').requestFullscreen()">Fullscreen</button>`)
      await writeFile(flowPath, when === 'ready'
        ? `export async function ready({ page }) {\n  ${enterFullscreen}\n}\nexport default async ({ wait }) => { await wait(0.3) }\n`
        : `export default async ({ page, wait }) => {\n  ${enterFullscreen}\n  await wait(0.3)\n}\n`)
      const config = createConfig({ url: pathToFileURL(page).href, flow: flowPath, viewportWidth: 320, viewportHeight: 200, scale, fps: 30, postRoll: 0 })

      const { rawPath } = await captureFlow({ config, flow: await loadFlow(flowPath, config.viewport), directory })

      const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-of', 'csv=p=0', rawPath])
      assert.deepEqual([...new Set(stdout.trim().split(/\s+/))], [`${320 * scale},${200 * scale}`])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
