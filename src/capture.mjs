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

export async function captureFlow({ config, flow, directory, page, signal: callerSignal }) {
  const signal = callerSignal ?? new AbortController().signal
  const rawPath = join(directory, 'capture.webm')
  const trace = { initialPointer: flow.initialPointer, moves: [], clicks: [] }

  signal.throwIfAborted()
  const browser = page ? undefined : await launchBrowser(config, { handleSignals: !callerSignal })
  let clock
  let recording = false
  let failed = false
  try {
    if (browser) {
      page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale, storageState: config.storageState })
      await raceAbort(waitForReady(page, flow, config, signal), signal)
      signal.throwIfAborted()
      await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)
    } else {
      await assertPageGeometry(page, config, signal)
    }

    const firstFrame = Promise.withResolvers()
    signal.throwIfAborted()
    await startScreencast(page, rawPath, config, firstFrame.resolve)
    recording = true
    const frame = await withDeadline(
      () => firstFrame.promise,
      FIRST_FRAME_TIMEOUT,
      new TraceframeError(`No screencast frame arrived within ${FIRST_FRAME_TIMEOUT / 1000} seconds.`, { code: 'FIRST_FRAME_TIMEOUT' }),
      signal,
    )
    clock = frame.timestamp
    if (!browser) {
      assertFrameSize(frame, config)
      signal.throwIfAborted()
      // Rejected caller-page attempts must leave the caller's pointer alone.
      await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)
    }
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
    return { rawPath, trace, startedAt: clock }
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
    if (browser) {
      if (failed) await browser.close().catch(() => {})
      else await browser.close()
    }
  }
}

async function assertPageGeometry(page, config, signal) {
  const [width, height, scale, left, top] = await withDeadline(
    () => page.evaluate(() => [innerWidth, innerHeight, visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop]),
    FIRST_FRAME_TIMEOUT,
    new TraceframeError(`Could not verify page geometry within ${FIRST_FRAME_TIMEOUT / 1000} seconds. Make sure the page is responsive.`, { code: 'CAPTURE_SIZE_MISMATCH' }),
    signal,
  )
  if (width !== config.viewport.width || height !== config.viewport.height || scale !== 1 || left !== 0 || top !== 0) {
    throw new TraceframeError(`Page geometry is ${width}×${height} with visual scale ${scale} and offset ${left},${top}; expected ${config.viewport.width}×${config.viewport.height} with scale 1 and no offset. Use 100% browser zoom and an unscaled page, and keep its geometry fixed during recording.`, { code: 'CAPTURE_SIZE_MISMATCH' })
  }
}

function assertFrameSize(frame, config) {
  // Playwright may pad the saved WebM. Check the actual JPEG, not DPR or the container size.
  const size = jpegSize(frame.data)
  if (size?.width !== config.video.width || size?.height !== config.video.height ||
      frame.viewportWidth !== config.viewport.width || frame.viewportHeight !== config.viewport.height) {
    const scaleHint = config.scale === 2 ? ' For scale 2, launch Chromium with --force-device-scale-factor=2; deviceScaleFactor alone is insufficient.' : ''
    throw new TraceframeError(`Screencast frames are ${size ? `${size.width}×${size.height}` : 'not a readable JPEG'} for a ${frame.viewportWidth}×${frame.viewportHeight} viewport; expected ${config.video.width}×${config.video.height} for a ${config.viewport.width}×${config.viewport.height} viewport. Keep the viewport fixed and use the page exclusively for this recording.${scaleHint}`, { code: 'CAPTURE_SIZE_MISMATCH' })
  }
}

function jpegSize(data) {
  if (data.length < 2 || data.readUInt16BE(0) !== 0xffd8) return undefined
  for (let offset = 2; offset + 8 < data.length;) {
    const marker = data.readUInt16BE(offset)
    // Chromium emits baseline JPEG; accept the other SOF encodings as well.
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
    }
    const length = data.readUInt16BE(offset + 2)
    if (length < 2) return undefined
    offset += length + 2
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
    // Playwright added our frame client before looking for FFmpeg; no caller recorder was active.
    await page.screencast.stop().catch(() => {})
    throw new TraceframeError("Playwright's FFmpeg is not installed. It is needed to record, even with --browser. Run `npx playwright@1.64.1 install ffmpeg`.", { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
  }
}

// Settles with the task, or rejects at the deadline or on abort, even if the task ignores its signal.
async function withDeadline(task, milliseconds, error, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(error), milliseconds)
  const deadline = AbortSignal.any([signal, controller.signal])
  try {
    deadline.throwIfAborted()
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
