import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { captureFlow } from '../src/capture.mjs'
import { createConfig } from '../src/config.mjs'
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
