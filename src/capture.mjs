import { addAbortListener } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

import { TraceframeError } from './errors.mjs'
import { addDiagnostics, retainedFile } from './diagnostics.mjs'
import { createFlowApi } from './flow.mjs'

const PLAYWRIGHT_DEFAULT_TIMEOUT = 30_000
const FIRST_FRAME_TIMEOUT = 10_000
const FAILURE_SCREENSHOT_TIMEOUT = 5_000

export async function captureFlow({ config, flow, directory, signal: callerSignal }) {
  const signal = callerSignal ?? new AbortController().signal
  const rawPath = join(directory, 'capture.webm')
  const trace = { initialPointer: flow.initialPointer, moves: [], clicks: [] }

  signal.throwIfAborted()
  const browser = await launchBrowser(config, { handleSignals: !callerSignal })
  let page
  let clock
  let recording = false
  let failed = false
  try {
    page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale, storageState: config.storageState })
    await raceAbort(waitForReady(page, flow, config, signal), signal)
    await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)

    const firstFrame = Promise.withResolvers()
    await startScreencast(page, rawPath, config, ({ timestamp }) => firstFrame.resolve(timestamp))
    recording = true
    clock = await withDeadline(
      () => firstFrame.promise,
      FIRST_FRAME_TIMEOUT,
      new TraceframeError(`No screencast frame arrived within ${FIRST_FRAME_TIMEOUT / 1000} seconds.`, { code: 'FIRST_FRAME_TIMEOUT' }),
      signal,
    )
    try {
      await withDeadline(
        (flowSignal) => flow.run({ page, signal: flowSignal, ...createFlowApi({ page, trace, clock, viewport: config.viewport, signal: flowSignal }) }),
        config.flowTimeout * 1000,
        new TraceframeError(`Flow exceeded the ${config.flowTimeout}-second flow timeout. Raise it with the flowTimeout option, or --flow-timeout.`, { code: 'FLOW_TOO_LONG' }),
        signal,
      )
    } catch (error) {
      if (signal.aborted || error instanceof TraceframeError) throw error
      throw new TraceframeError(error instanceof Error ? error.message : String(error), { code: 'FLOW_FAILED', cause: error })
    }
    trace.end = (Date.now() - clock) / 1000
    await delay(config.postRoll * 1000, undefined, { signal })
    // A failed stop must not be retried: Playwright may still be waiting to finish its artifact.
    recording = false
    await page.screencast.stop()
    return { rawPath, trace }
  } catch (error) {
    failed = true
    const recordingTime = clock === undefined ? undefined : Math.max(0, (Date.now() - clock) / 1000)
    // Let the encoder finish saving before closing the browser, including on slower machines.
    const [capturePath, screenshotPath] = await Promise.all([
      recording ? page.screencast.stop()
        .then(() => config.runDirectory ? retainedFile(rawPath) : undefined)
        .catch(() => undefined) : undefined,
      config.runDirectory && page && !signal.aborted ? saveFailureScreenshot(page, directory, signal) : undefined,
    ])
    if (signal.aborted) throw error
    throw await addDiagnostics(error, { flow: config.flow, recordingTime, capturePath, screenshotPath })
  } finally {
    // A shutdown error must not hide the flow failure.
    if (failed) await browser.close().catch(() => {})
    else await browser.close()
  }
}

async function saveFailureScreenshot(page, directory, signal) {
  try {
    return await withDeadline(async (diagnosticSignal) => {
      const screenshot = await page.screenshot({ timeout: FAILURE_SCREENSHOT_TIMEOUT })
      diagnosticSignal.throwIfAborted()
      const path = join(directory, 'failure.png')
      await writeFile(path, screenshot, { signal: diagnosticSignal })
      return path
    }, FAILURE_SCREENSHOT_TIMEOUT, new Error('Failure screenshot timed out.'), signal)
  } catch {
    return undefined
  }
}

async function launchBrowser(config, { handleSignals }) {
  try {
    return await chromium.launch({
      executablePath: config.browser,
      args: config.scale === 2 ? ['--force-device-scale-factor=2'] : [],
      handleSIGINT: handleSignals,
      handleSIGTERM: handleSignals,
      handleSIGHUP: handleSignals,
    })
  } catch (error) {
    if (!/Executable doesn't exist/i.test(error.message)) throw error
    const message = config.browser
      ? `Configured browser executable is unavailable: ${config.browser}`
      : 'Playwright Chromium is not installed. Run `npx playwright@1.64.1 install --only-shell chromium`, or pass --browser to a Chrome executable and run `npx playwright@1.64.1 install ffmpeg`.'
    throw new TraceframeError(message, { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
  }
}

async function waitForReady(page, flow, config, signal) {
  try {
    page.setDefaultTimeout(config.readyTimeout * 1000)
    await page.goto(config.url)
    await page.evaluate(() => document.fonts.ready)
    await flow.ready?.({ page, signal })
    page.setDefaultTimeout(PLAYWRIGHT_DEFAULT_TIMEOUT)
  } catch (error) {
    throw new TraceframeError(`Ready check failed: ${error instanceof Error ? error.message : error}`, { code: 'READY_FAILED', cause: error })
  }
}

async function startScreencast(page, path, config, onFrame) {
  try {
    await page.screencast.start({ path, size: { width: config.video.width, height: config.video.height }, fps: config.video.fps, quality: 95, onFrame })
  } catch (error) {
    if (!/Executable doesn't exist/i.test(error.message)) throw error
    throw new TraceframeError("Playwright's FFmpeg is not installed. It is needed to record, even with --browser. Run `npx playwright@1.64.1 install ffmpeg`.", { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
  }
}

// Settles with the task, or rejects at the deadline or on abort, even if the task ignores its signal.
async function withDeadline(task, milliseconds, error, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(error), milliseconds)
  const deadline = AbortSignal.any([signal, controller.signal])
  try {
    return await raceAbort(task(deadline), deadline)
  } finally {
    clearTimeout(timer)
  }
}

async function raceAbort(promise, signal) {
  const aborted = Promise.withResolvers()
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason))
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    listener[Symbol.dispose]()
  }
}
