import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { record } from '../src/index.mjs'

// Flow source that defines markStarted(), which writes a "started" file next to the flow.
const markStarted = `import { writeFileSync } from 'node:fs'\nconst markStarted = () => writeFileSync(new URL('./started', import.meta.url), '')\n`

async function withRecording(flowSource, run) {
  const fixtures = await mkdtemp(join(tmpdir(), 'traceframe-abort-fixtures-'))
  const temp = await mkdtemp(join(tmpdir(), 'traceframe-abort-tmp-'))
  const outputDirectory = await mkdtemp(join(tmpdir(), 'traceframe-abort-out-'))
  const previousTemp = process.env.TMPDIR
  process.env.TMPDIR = temp
  try {
    await writeFile(join(fixtures, 'page.html'), '<button style="margin:200px">Ready</button>')
    await writeFile(join(fixtures, 'flow.mjs'), flowSource)
    await run({
      options: { url: pathToFileURL(join(fixtures, 'page.html')).href, flow: join(fixtures, 'flow.mjs'), output: join(outputDirectory, 'video.mp4') },
      fixtures,
      temp,
      outputDirectory,
    })
  } finally {
    if (previousTemp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTemp
    await Promise.all([fixtures, temp, outputDirectory].map((directory) => rm(directory, { recursive: true, force: true })))
  }
}

// Aborts once the flow writes its "started" file, so each test stops in the step it is about.
function abortWhenStarted(fixtures, reason) {
  const controller = new AbortController()
  let abortedAt
  const watcher = setInterval(() => {
    if (!existsSync(join(fixtures, 'started'))) return
    clearInterval(watcher)
    abortedAt = performance.now()
    controller.abort(reason)
  }, 10).unref()
  return { signal: controller.signal, abortedAt: () => abortedAt }
}

test('an already aborted signal stops before the flow file is loaded', async () => {
  await withRecording(`${markStarted}markStarted()\nexport default async () => {}\n`, async ({ options, fixtures }) => {
    const reason = new Error('stop')
    await assert.rejects(record({ ...options, signal: AbortSignal.abort(reason) }), (error) => error === reason)
    assert.equal(existsSync(join(fixtures, 'started')), false)
  })
})

test('the flow timeout stops a flow that ignores its signal and removes temporary files', { timeout: 30_000 }, async () => {
  await withRecording('export default async () => { await new Promise(() => {}) }', async ({ options, temp, outputDirectory }) => {
    await assert.rejects(record({ ...options, preset: 'draft', flowTimeout: 0.2, signal: AbortSignal.timeout(10_000) }), {
      code: 'FLOW_TOO_LONG', message: /^Flow exceeded the 0\.2-second flow timeout\./,
    })
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(await readdir(outputDirectory), [])
  })
})

test('the flow timeout excludes preparation and post-roll', { timeout: 30_000 }, async () => {
  const flow = `export async function ready() { await new Promise((resolve) => setTimeout(resolve, 700)) }
export default async ({ wait }) => { await wait(0.1) }`
  await withRecording(flow, async ({ options }) => {
    const summary = await record({ ...options, preset: 'draft', flowTimeout: 0.5, postRoll: 0.7 })
    assert.ok(summary.duration >= 0.8)
  })
})

test('aborting during the flow stops a pending wait and removes temporary files', { timeout: 60_000 }, async () => {
  const flow = `${markStarted}export default async ({ page }) => { markStarted(); await page.getByRole('button', { name: 'Never' }).waitFor() }\n`
  await withRecording(flow, async ({ options, fixtures, temp, outputDirectory }) => {
    const reason = new Error('stop')
    const { signal, abortedAt } = abortWhenStarted(fixtures, reason)

    await assert.rejects(record({ ...options, preset: 'draft', signal }), (error) => error === reason)

    assert.ok(performance.now() - abortedAt() < 3_000)
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(await readdir(outputDirectory), [])
  })
})

test('aborting during a ready hook that ignores the signal stops and removes temporary files', { timeout: 60_000 }, async () => {
  const flow = `${markStarted}export async function ready() { markStarted(); await new Promise(() => {}) }\nexport default async () => {}\n`
  await withRecording(flow, async ({ options, fixtures, temp, outputDirectory }) => {
    const reason = new Error('stop')
    const { signal, abortedAt } = abortWhenStarted(fixtures, reason)

    await assert.rejects(record({ ...options, preset: 'draft', signal }), (error) => error === reason)

    assert.ok(performance.now() - abortedAt() < 3_000)
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(await readdir(outputDirectory), [])
  })
})

test('aborting during the render stops FFmpeg and removes temporary files', { timeout: 120_000 }, async () => {
  await withRecording(`export default async ({ page, hover, wait }) => { await hover(page.getByRole('button'), { duration: 0.5 }); await wait(4) }\n`, async ({ options, temp, outputDirectory }) => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const watcher = setInterval(async () => {
      const files = await readdir(outputDirectory)
      if (files.some((name) => name.endsWith('.tmp.mp4'))) controller.abort(reason)
    }, 10)
    try {
      await assert.rejects(record({ ...options, preset: 'standard', signal: controller.signal }), (error) => error === reason)
    } finally {
      clearInterval(watcher)
    }

    assert.ok(controller.signal.aborted)
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(await readdir(outputDirectory), [])
    assert.equal(existsSync(options.output), false)
  })
})

test('aborting during the post-roll stops at once and removes temporary files', { timeout: 60_000 }, async () => {
  await withRecording(`${markStarted}export default async () => { markStarted() }\n`, async ({ options, fixtures, temp, outputDirectory }) => {
    const reason = new Error('stop')
    const { signal, abortedAt } = abortWhenStarted(fixtures, reason)

    await assert.rejects(record({ ...options, preset: 'draft', postRoll: 10, signal }), (error) => error === reason)

    assert.ok(performance.now() - abortedAt() < 3_000)
    assert.deepEqual(await readdir(temp), [])
    assert.deepEqual(await readdir(outputDirectory), [])
  })
})
