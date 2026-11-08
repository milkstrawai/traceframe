import { addAbortListener } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { TraceframeError } from './errors.mjs'
import { addDiagnostics, retainedFile } from './diagnostics.mjs'
import { createFlowApi } from './flow.mjs'
import { createCaptureStats } from './capture-stats.mjs'
import { createJpegCapture } from './jpeg-capture.mjs'
import { launchBrowser, inspectGraphics } from './browser.mjs'

const PLAYWRIGHT_DEFAULT_TIMEOUT = 30_000
const FIRST_FRAME_TIMEOUT = 10_000
const FAILURE_SCREENSHOT_TIMEOUT = 5_000

export async function captureFlow({ config, flow, directory, page, signal: callerSignal }) {
  const captureErrors = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, captureErrors.signal]) : captureErrors.signal
  const rawPath = join(directory, 'capture.mkv')
  const trace = { initialPointer: flow.initialPointer, moves: [], clicks: [] }
  const stats = config.captureDiagnostics ? createCaptureStats() : undefined

  signal.throwIfAborted()
  const launched = page ? undefined : await launchBrowser(config, { handleSignals: !callerSignal, signal })
  const browser = launched?.browser
  let graphics = launched?.graphics
  let clock
  let recording = false
  let failed = false
  let capture
  async function stopCapture() {
    const stoppedAt = Date.now()
    try { await page.screencast.stop() } finally { await capture?.stop(stoppedAt) }
  }
  try {
    if (browser) {
      page = launched.page
      await raceAbort(waitForReady(page, flow, config, signal), signal)
      signal.throwIfAborted()
      await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)
    } else {
      await assertPageGeometry(page, config, signal)
      graphics = { requested: 'caller', ...await inspectGraphics(page.context().browser(), signal) }
    }

    const firstFrame = Promise.withResolvers()
    signal.throwIfAborted()
    capture = createJpegCapture(rawPath, { ...config.video, onError: cause => captureErrors.abort(new TraceframeError(`Could not save capture: ${cause.message}`, { code: 'CAPTURE_FAILED', cause })) })
    await page.screencast.start({ size: { width: config.video.width, height: config.video.height }, fps: config.video.fps, quality: config.captureQuality, onFrame: (frame) => {
      stats?.observe(frame.timestamp, performance.now())
      firstFrame.resolve(frame)
      return capture.append(frame)
    } })
    recording = true
    const frame = await withDeadline(
      () => firstFrame.promise,
      FIRST_FRAME_TIMEOUT,
      new TraceframeError(`No screencast frame arrived within ${FIRST_FRAME_TIMEOUT / 1000} seconds.`, { code: 'FIRST_FRAME_TIMEOUT' }),
      signal,
    )
    clock = frame.timestamp
    assertFrameSize(frame, config)
    if (!browser) {
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
    // Stop the page subscription only once, including when shutdown fails.
    recording = false
    await stopCapture()
    return { rawPath, trace, startedAt: clock, graphics, ...(stats ? { captureStats: { ...stats.summary(), ...capture.stats } } : {}) }
  } catch (error) {
    failed = true
    // A writer failure during cleanup must not replace the initiating failure.
    const failure = signal.aborted ? signal.reason : error
    const recordingTime = clock === undefined ? undefined : Math.max(0, (Date.now() - clock) / 1000)
    // Flush captured frames before closing the browser, including on slower disks.
    const [capturePath, screenshotPath] = await Promise.all([
      (recording ? stopCapture().catch(() => {}) : Promise.resolve())
        .then(() => capture?.stop())
        .then(() => clock !== undefined && config.runDirectory ? retainedFile(rawPath) : undefined)
        .catch(() => undefined),
      config.runDirectory && page && !signal.aborted ? saveFailureScreenshot(page, directory, signal) : undefined,
    ])
    if (callerSignal?.aborted) throw callerSignal.reason
    throw await addDiagnostics(failure, { flow: config.flow, recordingTime, capturePath, screenshotPath })
  } finally {
    await capture?.stop().catch(() => {})
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
  // Check the exported JPEG dimensions; deviceScaleFactor alone is insufficient.
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
