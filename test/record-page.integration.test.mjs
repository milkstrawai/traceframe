import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

import { recordPage } from '../src/index.mjs'

const run = promisify(execFile)
const viewport = { width: 320, height: 240 }
const html = '<body style="background:#dcecf5"><button style="margin:60px" onclick="this.textContent = \'Saved\'">Save</button></body>'

async function withPage(check, { scale = 1, deviceScaleFactor = scale, persistent = false, isMobile = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-page-'))
  const launch = { args: scale === 2 ? ['--force-device-scale-factor=2'] : [] }
  const browser = persistent ? undefined : await chromium.launch(launch)
  const context = persistent
    ? await chromium.launchPersistentContext(join(directory, 'profile'), { ...launch, viewport, deviceScaleFactor })
    : await browser.newContext({ viewport, deviceScaleFactor, isMobile })
  const page = await context.newPage()
  try {
    await page.goto(`data:text/html,${encodeURIComponent(html)}`)
    await check({ page, context, directory, options: { page, scale, output: join(directory, 'video.mp4'), postRoll: 0 } })
  } finally {
    await (browser ?? context).close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function checkVideo(path, width, height) {
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type', '-of', 'json', path])
  assert.deepEqual(JSON.parse(stdout).streams, [{ codec_type: 'video', width, height }])
}

for (const scale of [1, 2]) {
  test(`records a caller page at scale ${scale} and supports another take without changing page settings`, { timeout: 30_000 }, async () => {
    await withPage(async ({ page, options }) => {
      page.setDefaultTimeout(150)
      const url = page.url()
      const save = page.getByRole('button', { name: 'Save' })
      const result = await recordPage({ ...options, initialPointer: { x: 10, y: 10 }, flow: async ({ page: supplied, click, wait }) => {
        assert.equal(supplied, page)
        await click(save, { duration: 0.05, dwell: 0 })
        await wait(0.1)
      } })
      assert.equal(result.clickCount, 1)
      assert.equal(result.width, viewport.width * scale)
      assert.equal(result.height, viewport.height * scale)
      assert.equal(page.isClosed(), false)
      assert.equal(page.url(), url)
      assert.deepEqual(page.viewportSize(), viewport)
      assert.equal(await page.getByRole('button').textContent(), 'Saved')
      // A reset to Playwright's 30s timeout would exceed this test's deadline.
      await assert.rejects(page.getByText('Never present').waitFor(), { name: 'TimeoutError' })
      await checkVideo(result.output, result.width, result.height)
      const second = await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
      assert.equal(second.clickCount, 0)
    }, { scale })
  })
}

test('records from a persistent context and leaves it usable', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, context, options }) => {
    await recordPage({ ...options, flow: async ({ click }) => click(page.getByRole('button'), { duration: 0.01, dwell: 0 }) })
    assert.equal(await page.getByRole('button').textContent(), 'Saved')
    assert.ok(context.pages().includes(page))
    const next = await context.newPage()
    await next.close()
  }, { persistent: true })
})

test('DPR alone cannot silently create a padded, misaligned scale-2 recording', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, options }) => {
    assert.equal(await page.evaluate(() => devicePixelRatio), 2)
    let called = false
    await assert.rejects(recordPage({ ...options, scale: 2, flow: () => { called = true } }), { code: 'CAPTURE_SIZE_MISMATCH' })
    assert.equal(called, false)
    assert.equal(page.isClosed(), false)
    // Geometry rejection stopped our screencast, so the page can immediately be reused at its actual scale.
    await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
  }, { deviceScaleFactor: 2 })
})

for (const mobile of [true, false]) {
  test(`rejects ${mobile ? 'mobile layout scaling' : 'pinch zoom'} before recording or moving the caller pointer`, { timeout: 30_000 }, async (t) => {
    await withPage(async ({ page, context, options }) => {
      const cdp = await context.newCDPSession(page)
      if (!mobile) await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 })
      const geometry = () => page.evaluate(() => [innerWidth, innerHeight, visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop])
      const before = await geometry()
      assert.notEqual(before[2], 1)
      if (!mobile) assert.deepEqual(before.slice(0, 2), [viewport.width, viewport.height])
      const move = t.mock.method(page.mouse, 'move')
      const start = t.mock.method(page.screencast, 'start')
      let called = false
      await assert.rejects(recordPage({ ...options, flow: () => { called = true } }), { code: 'CAPTURE_SIZE_MISMATCH' })
      assert.equal(called, false)
      assert.equal(move.mock.callCount(), 0)
      assert.equal(start.mock.callCount(), 0)
      assert.deepEqual(await geometry(), before)
      // The caller can restore supported geometry and record again on the same page.
      await page.setContent(`<meta name="viewport" content="width=device-width">${html}`)
      if (!mobile) await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
      await recordPage({ ...options, flow: async ({ click }) => click(page.getByRole('button'), { duration: 0.01, dwell: 0 }) })
      assert.equal(await page.getByRole('button').textContent(), 'Saved')
    }, { isMobile: mobile })
  })
}

for (const cancel of [false, true]) {
  test(`an unresponsive geometry read ${cancel ? 'can be cancelled' : 'has a startup deadline'}`, { timeout: 30_000 }, async (t) => {
    await withPage(async ({ page, options }) => {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      t.after(() => release.resolve())
      const controller = new AbortController()
      const reason = new Error('cancel geometry check')
      const evaluate = page.evaluate.bind(page)
      let evaluation
      const read = t.mock.method(page, 'evaluate', (...args) => {
        evaluation = release.promise.then(() => evaluate(...args))
        entered.resolve()
        return evaluation
      })
      const move = t.mock.method(page.mouse, 'move')
      const start = t.mock.method(page.screencast, 'start')
      const flow = t.mock.fn()
      try {
        const rejected = assert.rejects(recordPage({ ...options, signal: controller.signal, flow }), cancel
          ? error => error === reason
          : { code: 'CAPTURE_SIZE_MISMATCH', message: /verify page geometry within 10 seconds/ })
        await Promise.race([entered.promise, rejected])
        if (cancel) controller.abort(reason)
        await rejected
      } finally {
        release.resolve()
        await evaluation
        read.mock.restore()
      }
      assert.equal(flow.mock.callCount(), 0)
      assert.equal(move.mock.callCount(), 0)
      assert.equal(start.mock.callCount(), 0)
      await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
    })
  })
}

test('successive takes release detached targets while preserving caller-owned handles', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, context, options }) => {
    const cdp = await context.newCDPSession(page)
    const callerHandle = await page.locator('body').elementHandle()
    try {
      for (let take = 0; take < 3; take++) {
        await page.evaluate(() => {
          const button = document.createElement('button')
          button.textContent = 'Remove'
          button.onclick = () => button.remove()
          document.body.replaceChildren(button)
          window.targets ??= []
          window.targets.push(new WeakRef(button))
        })
        await recordPage({ ...options, flow: async ({ click }) => click(page.getByRole('button'), { duration: 0.01, dwell: 0 }) })
        await cdp.send('HeapProfiler.collectGarbage')
        assert.deepEqual(await page.evaluate(() => targets.map(ref => Boolean(ref.deref()))), Array(take + 1).fill(false))
        assert.equal(await callerHandle.evaluate(body => body.isConnected), true)
      }
    } finally {
      await callerHandle.dispose()
    }
  })
})

test('a helper releases a handle that arrives after the recording was cancelled', { timeout: 30_000 }, async (t) => {
  await withPage(async ({ page, context, options }) => {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(() => release.resolve())
    const controller = new AbortController()
    const reason = new Error('cancel before handle arrives')
    const button = page.getByRole('button')
    const getHandle = button.elementHandle.bind(button)
    button.elementHandle = async (options) => {
      const element = await getHandle(options)
      entered.resolve()
      await release.promise
      return element
    }
    let helper
    try {
      const rejected = assert.rejects(recordPage({ ...options, signal: controller.signal, flow: ({ hover }) => {
        helper = hover(button, { duration: 0.01 })
        return helper
      } }), error => error === reason)
      await Promise.race([entered.promise, rejected])
      controller.abort(reason)
      await rejected
      await page.evaluate(() => {
        const button = document.querySelector('button')
        window.target = new WeakRef(button)
        button.remove()
      })
    } finally {
      release.resolve()
      await assert.rejects(helper)
    }
    // A detached node can remain in Chromium's rendering state until the next frame.
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const cdp = await context.newCDPSession(page)
    await cdp.send('HeapProfiler.collectGarbage')
    assert.equal(await page.evaluate(() => Boolean(target.deref())), false)
  })
})

test('downscaled frames cannot hide a changed page viewport', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, options }) => {
    const start = page.screencast.start.bind(page.screencast)
    page.screencast.start = async (settings) => {
      await page.setViewportSize({ width: 640, height: 480 })
      return start(settings)
    }
    let called = false
    await assert.rejects(recordPage({ ...options, flow: () => { called = true } }), error => {
      assert.equal(error.code, 'CAPTURE_SIZE_MISMATCH')
      assert.match(error.message, /320×240 for a 640×480 viewport; expected 320×240 for a 320×240 viewport/)
      assert.doesNotMatch(error.message, /force-device-scale-factor/)
      return true
    })
    assert.equal(called, false)
    assert.equal(page.isClosed(), false)
  })
})

test('callback failures retain diagnostic artifacts without a flow filename and allow reuse', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, directory, options }) => {
    const problem = new Error('expected Saved')
    const runDirectory = join(directory, 'run')
    await assert.rejects(recordPage({ ...options, runDirectory, flow: async ({ wait }) => { await wait(0.1); throw problem } }), error => {
      assert.equal(error.code, 'FLOW_FAILED')
      assert.equal(error.cause, problem)
      assert.deepEqual(error.diagnostics.flowLocations, [])
      assert.ok(Number.isFinite(error.diagnostics.recordingTime))
      assert.equal(error.diagnostics.capturePath, join(runDirectory, 'capture.webm'))
      assert.equal(error.diagnostics.screenshotPath, join(runDirectory, 'failure.png'))
      return true
    })
    assert.ok((await readFile(join(runDirectory, 'failure.png'))).length > 0)
    await checkVideo(join(runDirectory, 'capture.webm'), viewport.width, viewport.height)
    assert.equal(page.isClosed(), false)
    await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
  })
})

test('cancellation preserves the caller reason and leaves the page reusable', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, options }) => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    await assert.rejects(recordPage({ ...options, signal: controller.signal, flow: async ({ click }) => {
      controller.abort(reason)
      await click(page.getByRole('button'))
    } }), error => error === reason)
    assert.equal(reason.diagnostics, undefined)
    assert.equal(await page.getByRole('button').textContent(), 'Save')
    await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
  })
})

test('a timed-out callback cannot click after its target becomes enabled', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, options }) => {
    const button = page.getByRole('button')
    await button.evaluate(node => { node.disabled = true })
    await assert.rejects(recordPage({ ...options, flowTimeout: 0.2, flow: ({ click }) => click(button, { duration: 0.01, dwell: 0 }) }), { code: 'FLOW_TOO_LONG' })
    await button.evaluate(node => { node.disabled = false })
    await recordPage({ ...options, flow: async ({ wait }) => wait(0.2) })
    assert.equal(await button.textContent(), 'Save')
  })
})

test('overlapping calls reject without disturbing the first take', { timeout: 30_000 }, async () => {
  await withPage(async ({ options }) => {
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const first = recordPage({ ...options, flow: async () => { entered.resolve(); await finish.promise } })
    try {
      await Promise.race([entered.promise, first])
      await assert.rejects(recordPage({ ...options, flow: () => {} }), { code: 'PAGE_RECORDING_ACTIVE' })
    } finally {
      finish.resolve()
      await first
    }
  })
})

test('an existing caller screencast survives a rejected recording attempt', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, directory, options }) => {
    const path = join(directory, 'caller.webm')
    await page.screencast.start({ path, size: viewport, fps: 30 })
    await assert.rejects(recordPage({ ...options, flow: () => {} }), /already started/)
    await assert.rejects(page.screencast.start(), /already started/)
    await page.screencast.stop()
    await checkVideo(path, viewport.width, viewport.height)
  })
})

test('missing FFmpeg after a partial start leaves the page reusable', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, options }) => {
    const problem = new Error("Executable doesn't exist at synthetic-ffmpeg")
    const start = page.screencast.start.bind(page.screencast)
    page.screencast.start = async (settings) => {
      page.screencast.start = start
      // A real frame client starts, but no video artifact exists when the FFmpeg lookup fails.
      await start({ ...settings, path: undefined })
      throw problem
    }
    let called = false
    await assert.rejects(recordPage({ ...options, flow: () => { called = true } }), error => {
      assert.equal(error.code, 'PLAYWRIGHT_RUNTIME_MISSING')
      assert.equal(error.cause, problem)
      return true
    })
    assert.equal(called, false)
    assert.equal(page.isClosed(), false)
    await recordPage({ ...options, flow: async ({ wait }) => wait(0.1) })
  })
})

test('page closure during a take fails without claiming a saved capture', { timeout: 30_000 }, async () => {
  await withPage(async ({ page, context, directory, options }) => {
    const runDirectory = join(directory, 'run')
    await assert.rejects(recordPage({ ...options, runDirectory, flow: () => page.close() }), error => {
      assert.equal(error.diagnostics?.capturePath, undefined)
      return true
    })
    assert.deepEqual(await readdir(runDirectory), [])
    const other = await context.newPage()
    await other.close()
  })
})
