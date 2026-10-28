import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { record } from '../src/index.mjs'

const run = promisify(execFile)
const errorModule = new URL('../src/errors.mjs', import.meta.url).href

async function withFixture(source, check) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-diagnostics-'))
  try {
    const flow = join(directory, 'flow.mjs')
    const page = join(directory, 'page.html')
    const runDirectory = join(directory, 'run')
    await writeFile(flow, source)
    await writeFile(page, '<h1>Example workspace</h1><button>Save</button>')
    const options = { url: pathToFileURL(page).href, flow, output: join(directory, 'video.mp4'), runDirectory, preset: 'draft', viewportWidth: 640, viewportHeight: 480, postRoll: 0 }
    await check({ options, directory, module: await import(pathToFileURL(flow).href) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function failure(options) {
  let caught
  await assert.rejects(record(options), (error) => { caught = error; return true })
  return caught
}

async function checkArtifacts(error, options) {
  assert.equal(error.diagnostics.capturePath, join(options.runDirectory, 'capture.webm'))
  assert.equal(error.diagnostics.screenshotPath, join(options.runDirectory, 'failure.png'))
  const png = await readFile(error.diagnostics.screenshotPath)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 640)
  assert.equal(png.readUInt32BE(20), 480)
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', error.diagnostics.capturePath, '-f', 'null', '-'])
  await assert.rejects(readFile(options.output), { code: 'ENOENT' })
}

test('a wrong locator retains a decodable capture, screenshot and the relevant flow locations', { timeout: 30_000 }, async () => {
  const source = `async function missingBadge(page) {
  await page.getByRole('status', { name: 'Saved' }).waitFor({ timeout: 200 })
}
export default async ({ page, wait }) => {
  await wait(0.3)
  await missingBadge(page)
}`
  await withFixture(source, async ({ options }) => {
    const error = await failure(options)
    assert.equal(error.code, 'FLOW_FAILED')
    assert.equal(error.message, error.cause.message)
    assert.equal(error.cause.name, 'TimeoutError')
    assert.match(error.message, /getByRole\('status'/)
    assert.ok(error.diagnostics.flowLocations.some(({ file, line }) => file === options.flow && line === 2))
    assert.ok(error.diagnostics.flowLocations.some(({ line }) => line === 6))
    await checkArtifacts(error, options)
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', error.diagnostics.capturePath])
    // Playwright pads the raw WebM with a repeated final frame; its duration is not the failure time.
    assert.ok(Number(stdout) >= error.diagnostics.recordingTime, `raw duration=${stdout.trim()}, failure time=${error.diagnostics.recordingTime}`)
  })
})

test('the failure time uses the first video frame and excludes screenshot collection', { timeout: 30_000 }, async () => {
  const source = `export const times = {}
export async function ready({ page }) {
  await new Promise(resolve => setTimeout(resolve, 300))
  const start = page.screencast.start.bind(page.screencast)
  page.screencast.start = options => start({ ...options, onFrame(frame) {
    times.firstFrame ??= frame.timestamp
    options.onFrame(frame)
  } })
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async options => {
    await new Promise(resolve => setTimeout(resolve, 1200))
    return screenshot(options)
  }
}
export default async ({ wait }) => {
  await wait(0.2)
  times.failed = Date.now()
  throw new Error('stopped at the result')
}`
  await withFixture(source, async ({ options, module }) => {
    const error = await failure(options)
    const expected = (module.times.failed - module.times.firstFrame) / 1000
    assert.ok(Math.abs(error.diagnostics.recordingTime - expected) < 0.1)
    assert.ok(Date.now() - module.times.failed >= 1200)
    await checkArtifacts(error, options)
  })
})

test('synchronous and non-Error flow exceptions get FLOW_FAILED with the original cause', { timeout: 30_000 }, async () => {
  for (const thrown of ["Object.assign(new Error('flow problem'), { code: 'APP_ERROR' })", "'plain failure'"]) {
    await withFixture(`export const problem = ${thrown}\nexport default () => { throw problem }`, async ({ options, module }) => {
      const error = await failure(options)
      assert.equal(error.code, 'FLOW_FAILED')
      assert.equal(error.cause, module.problem)
      assert.equal(error.message, module.problem.message ?? module.problem)
      assert.ok(Number.isFinite(error.diagnostics.recordingTime))
    })
  }
})

test('classified flow errors keep their identity, code and cause', { timeout: 30_000 }, async () => {
  const source = `import { TraceframeError } from ${JSON.stringify(errorModule)}
export const problem = new TraceframeError('covered target', { code: 'FLOW_TARGET_OBSCURED', cause: new Error('original cause') })
export default () => { throw problem }`
  await withFixture(source, async ({ options, module }) => {
    const cause = module.problem.cause
    const error = await failure(options)
    assert.equal(error, module.problem)
    assert.equal(error.cause, cause)
    assert.equal(error.code, 'FLOW_TARGET_OBSCURED')
    assert.ok(error.diagnostics.flowLocations.length > 0)
    assert.ok(error.diagnostics.flowLocations.every(({ line }) => line === 2))
  })
})

test('ready failures have a screenshot and flow location but no recording time or stale capture path', { timeout: 30_000 }, async () => {
  await withFixture("export function ready() { throw new Error('not ready') }\nexport default () => {}", async ({ options }) => {
    await mkdir(options.runDirectory)
    await writeFile(join(options.runDirectory, 'capture.webm'), 'old capture')
    const error = await failure(options)
    assert.equal(error.code, 'READY_FAILED')
    assert.equal(error.cause.message, 'not ready')
    assert.equal(error.diagnostics.recordingTime, undefined)
    assert.equal(error.diagnostics.capturePath, undefined)
    assert.equal(error.diagnostics.screenshotPath, join(options.runDirectory, 'failure.png'))
    assert.ok(error.diagnostics.flowLocations.some(({ line }) => line === 1))
  })
})

test('a browser setup failure does not claim recording artifacts', { timeout: 30_000 }, async () => {
  await withFixture('export default () => {}', async ({ options, directory }) => {
    const previousTemp = process.env.TMPDIR
    process.env.TMPDIR = directory
    try {
      const error = await failure({ ...options, browser: join(directory, 'missing-browser') })
      assert.equal(error.code, 'PLAYWRIGHT_RUNTIME_MISSING')
      assert.equal(error.diagnostics, undefined)
      assert.deepEqual(await readdir(options.runDirectory), [])
    } finally {
      if (previousTemp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTemp
    }
  })
})

test('a screencast startup failure keeps its original error and does not report an old capture', { timeout: 30_000 }, async () => {
  const source = `export const problem = new Error('screencast startup failed')
export function ready({ page }) { page.screencast.start = async () => { throw problem } }
export default () => {}`
  await withFixture(source, async ({ options, module }) => {
    await mkdir(options.runDirectory)
    await writeFile(join(options.runDirectory, 'capture.webm'), 'old capture')
    const error = await failure(options)
    assert.equal(error, module.problem)
    assert.equal(error.code, undefined)
    assert.equal(error.diagnostics.recordingTime, undefined)
    assert.equal(error.diagnostics.capturePath, undefined)
    assert.equal(error.diagnostics.screenshotPath, join(options.runDirectory, 'failure.png'))
  })
})

test('a flow timeout keeps FLOW_TOO_LONG and reports artifacts without inventing a flow location', { timeout: 30_000 }, async () => {
  await withFixture('export default () => new Promise(() => {})', async ({ options }) => {
    const error = await failure({ ...options, flowTimeout: 0.2 })
    assert.equal(error.code, 'FLOW_TOO_LONG')
    assert.deepEqual(error.diagnostics.flowLocations, [])
    assert.ok(error.diagnostics.recordingTime >= 0.18, `failure time=${error.diagnostics.recordingTime}`)
    await checkArtifacts(error, options)
  })
})

test('a missing first frame preserves its setup code and does not invent a recording time', { timeout: 30_000 }, async () => {
  const source = `export function ready({ page }) {
  const start = page.screencast.start.bind(page.screencast)
  page.screencast.start = options => start({ ...options, onFrame() {} })
}
export default () => { throw new Error('the flow must not run') }`
  await withFixture(source, async ({ options }) => {
    const error = await failure(options)
    assert.equal(error.code, 'FIRST_FRAME_TIMEOUT')
    assert.equal(error.diagnostics.recordingTime, undefined)
    await checkArtifacts(error, options)
  })
})

for (const screenshot of ["async () => { throw new Error('screenshot failed') }", '() => new Promise(() => {})']) {
  test(`a ${screenshot.includes('throw') ? 'failed' : 'stalled'} screenshot preserves the flow error and does not hold shutdown open`, { timeout: 30_000 }, async () => {
    const source = `export default ({ page }) => {
  page.screenshot = ${screenshot}
  throw new Error('original flow failure')
}`
    await withFixture(source, async ({ options }) => {
      const error = await failure(options)
      assert.equal(error.code, 'FLOW_FAILED')
      assert.equal(error.message, 'original flow failure')
      assert.equal(error.diagnostics.screenshotPath, undefined)
      assert.equal(error.diagnostics.capturePath, join(options.runDirectory, 'capture.webm'))
    })
  })
}

test('a screenshot write failure does not replace the original error or claim a screenshot', { timeout: 30_000 }, async () => {
  await withFixture("export default () => { throw new Error('flow failure') }", async ({ options }) => {
    await mkdir(join(options.runDirectory, 'failure.png'), { recursive: true })
    const error = await failure(options)
    assert.equal(error.message, 'flow failure')
    assert.equal(error.diagnostics.screenshotPath, undefined)
    assert.equal(error.diagnostics.capturePath, join(options.runDirectory, 'capture.webm'))
  })
})

test('a slow screencast save keeps the current capture instead of abandoning it after five seconds', { timeout: 30_000 }, async () => {
  const source = `export function ready({ page }) {
  const stop = page.screencast.stop.bind(page.screencast)
  page.screencast.stop = async () => {
    await new Promise(resolve => setTimeout(resolve, 5200))
    return stop()
  }
}
export default () => { throw new Error('original failure') }`
  await withFixture(source, async ({ options }) => {
    await mkdir(options.runDirectory)
    await writeFile(join(options.runDirectory, 'capture.webm'), 'old capture')
    const error = await failure(options)
    assert.equal(error.code, 'FLOW_FAILED')
    assert.equal(error.message, 'original failure')
    await checkArtifacts(error, options)
  })
})

test('a failed screencast stop is not retried and keeps its original error', { timeout: 30_000 }, async () => {
  const source = `export const problem = new Error('encoder could not finish')
export let stops = 0
export function ready({ page }) {
  page.screencast.stop = async () => { stops++; throw problem }
}
export default async ({ wait }) => { await wait(0.1) }`
  await withFixture(source, async ({ options, module }) => {
    const error = await failure(options)
    assert.equal(error, module.problem)
    assert.equal(module.stops, 1)
    assert.equal(error.diagnostics.capturePath, undefined)
    assert.equal(error.diagnostics.screenshotPath, join(options.runDirectory, 'failure.png'))
  })
})

test('a closed page and a browser-close error do not replace the flow failure', { timeout: 30_000 }, async () => {
  const source = `export default async ({ page }) => {
  const browser = page.context().browser()
  const close = browser.close.bind(browser)
  browser.close = async () => { await close(); throw new Error('close failure') }
  await page.close()
  throw new Error('flow failure')
}`
  await withFixture(source, async ({ options }) => {
    const error = await failure(options)
    assert.equal(error.code, 'FLOW_FAILED')
    assert.equal(error.message, 'flow failure')
    assert.equal(error.diagnostics.capturePath, undefined)
    assert.equal(error.diagnostics.screenshotPath, undefined)
  })
})

test('without a run directory, a failure keeps locations and time but takes no screenshot and removes temporary files', { timeout: 30_000 }, async () => {
  const source = `export let screenshots = 0
export default ({ page }) => {
  page.screenshot = async () => { screenshots++; throw new Error('should not take a screenshot') }
  throw new Error('flow failure')
}`
  await withFixture(source, async ({ options, directory, module }) => {
    const temp = join(directory, 'temp')
    await mkdir(temp)
    const previousTemp = process.env.TMPDIR
    process.env.TMPDIR = temp
    try {
      const error = await failure({ ...options, runDirectory: undefined })
      assert.equal(error.code, 'FLOW_FAILED')
      assert.ok(error.diagnostics.flowLocations.length > 0)
      assert.ok(Number.isFinite(error.diagnostics.recordingTime))
      assert.equal(error.diagnostics.capturePath, undefined)
      assert.equal(error.diagnostics.screenshotPath, undefined)
      assert.equal(module.screenshots, 0)
      assert.deepEqual(await readdir(temp), [])
    } finally {
      if (previousTemp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTemp
    }
  })
})

test('cancellation retains the exact signal reason, skips screenshots and still saves the partial capture', { timeout: 30_000 }, async () => {
  const source = `export const controller = new AbortController()
export const reason = new Error('caller stopped')
export let screenshots = 0
export default async ({ page, wait }) => {
  page.screenshot = async () => { screenshots++; throw new Error('unexpected screenshot') }
  await wait(0.2)
  controller.abort(reason)
  await new Promise(() => {})
}`
  await withFixture(source, async ({ options, module }) => {
    const error = await failure({ ...options, signal: module.controller.signal })
    assert.equal(error, module.reason)
    assert.equal(error.diagnostics, undefined)
    assert.equal(module.screenshots, 0)
    await run('ffmpeg', ['-v', 'error', '-xerror', '-i', join(options.runDirectory, 'capture.webm'), '-f', 'null', '-'])
  })
})

test('cancellation during diagnostics interrupts the screenshot and keeps the signal reason', { timeout: 30_000 }, async () => {
  const source = `export const controller = new AbortController()
export const reason = new Error('stop during diagnostics')
export default ({ page }) => {
  page.screenshot = () => {
    controller.abort(reason)
    return new Promise(() => {})
  }
  throw new Error('flow failure')
}`
  await withFixture(source, async ({ options, module }) => {
    const error = await failure({ ...options, signal: module.controller.signal })
    assert.equal(error, module.reason)
    assert.equal(error.diagnostics, undefined)
    await assert.rejects(readFile(join(options.runDirectory, 'failure.png')), { code: 'ENOENT' })
  })
})

test('a render failure reports the retained capture without being classified as a flow failure', { timeout: 30_000 }, async () => {
  await withFixture('export default async ({ wait }) => { await wait(0.1) }', async ({ options }) => {
    // Encoding succeeds, but the final rename cannot replace a directory with an MP4 file.
    await mkdir(options.output)
    const error = await failure(options)
    assert.notEqual(error.code, 'FLOW_FAILED')
    assert.equal(error.diagnostics.capturePath, join(options.runDirectory, 'capture.webm'))
    assert.equal(error.diagnostics.recordingTime, undefined)
    assert.equal(error.diagnostics.screenshotPath, undefined)
    assert.deepEqual(error.diagnostics.flowLocations, [])
  })
})

test('cancellation during render-failure diagnostics keeps the exact signal reason', { timeout: 30_000 }, async (t) => {
  await withFixture('export default async ({ wait }) => { await wait(0.1) }', async ({ options }) => {
    await mkdir(options.output)
    const controller = new AbortController()
    const reason = new Error('stop during render diagnostics')
    const stat = fs.stat
    // Cancel while collecting metadata after the final output rename fails.
    const diagnosticStat = t.mock.method(fs, 'stat', async (path, ...args) => {
      const result = await stat(path, ...args)
      if (path === join(options.runDirectory, 'capture.webm')) controller.abort(reason)
      return result
    })
    syncBuiltinESMExports()
    try {
      const error = await failure({ ...options, signal: controller.signal })
      assert.equal(error, reason)
      assert.equal(error.diagnostics, undefined)
    } finally {
      diagnosticStat.mock.restore()
      syncBuiltinESMExports()
    }
  })
})
