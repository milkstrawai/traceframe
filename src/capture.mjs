import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { runFiles } from './config.mjs'
import { TraceframeError } from './errors.mjs'
import { addDiagnostics, retainedFile } from './diagnostics.mjs'
import { createFlowApi, createTrace, secondsSince } from './flow.mjs'
import { createCaptureStats } from './capture-stats.mjs'
import { createJpegCapture } from './jpeg-capture.mjs'
import { launchBrowser } from './browser.mjs'
import { raceAbort, withDeadline } from './deadline.mjs'

const PLAYWRIGHT_DEFAULT_TIMEOUT = 30_000
const FIRST_FRAME_TIMEOUT = 10_000
const GEOMETRY_CHECK_TIMEOUT = 10_000
const FAILURE_SCREENSHOT_TIMEOUT = 5_000
// Playwright uses the screencast fps only to let Chromium have 10 frames in flight above 30,
// otherwise 5. Export sets the output rate, so 30 FPS output keeps the larger allowance: with 5,
// a busy machine captured fewer pictures without saving any work.
const SCREENCAST_FPS = 60

export async function captureFlow({ config, flow, directory, page, signal: callerSignal }) {
  const captureErrors = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, captureErrors.signal]) : captureErrors.signal
  const files = runFiles(directory)
  const rawPath = files.capture
  const trace = createTrace(flow.initialPointer)
  const stats = config.captureDiagnostics ? createCaptureStats() : undefined

  signal.throwIfAborted()
  const { browser, graphics } = page ? {} : await launchBrowser(config, { handleSignals: !callerSignal, signal })
  let clock
  let recording = false
  let failed = false
  let capture
  async function stopCapture() {
    const stoppedAt = Date.now()
    try { await page.screencast.stop() } finally { await capture?.stop(stoppedAt) }
  }
  // After a failure, flush the frames captured so far before the browser closes, including on slower disks.
  async function savePartialCapture() {
    try {
      if (recording) await stopCapture().catch(() => {})
      await capture?.stop()
      return clock !== undefined && config.runDirectory ? await retainedFile(rawPath) : undefined
    } catch {
      return undefined
    }
  }
  try {
    if (browser) {
      // A browser launch cannot be interrupted, so check before creating the page and again before navigation.
      signal.throwIfAborted()
      page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale, storageState: config.storageState })
      signal.throwIfAborted()
      await raceAbort(waitForReady(page, flow, config, signal), signal)
      signal.throwIfAborted()
      await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)
    } else {
      await assertPageGeometry(page, config, signal)
    }

    const firstFrame = Promise.withResolvers()
    signal.throwIfAborted()
    capture = createJpegCapture(rawPath, { ...config.video, onError: cause => captureErrors.abort(new TraceframeError(`Could not save capture: ${cause.message}`, { code: 'CAPTURE_FAILED', cause })) })
    let firstSize
    await page.screencast.start({ size: { width: config.video.width, height: config.video.height }, fps: SCREENCAST_FPS, quality: config.captureQuality, onFrame: (frame) => {
      stats?.observe(frame.timestamp, performance.now())
      firstFrame.resolve(frame)
      // The first frame is checked against the request below. A later size change would
      // otherwise surface only after export, as a truncated video.
      const size = frameSize(frame)
      firstSize ??= size
      if (!sameSize(size, firstSize)) {
        captureErrors.abort(new TraceframeError(`Screencast frames changed size during recording, from ${describeSize(firstSize)} to ${describeSize(size)}. Keep the page geometry fixed while recording.`, { code: 'CAPTURE_SIZE_CHANGED' }))
        return
      }
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
    trace.end = secondsSince(clock)
    await delay(config.postRoll * 1000, undefined, { signal })
    // Stop the page subscription only once, including when shutdown fails.
    recording = false
    await stopCapture()
    return { rawPath, trace, startedAt: clock, graphics, ...(stats ? { captureStats: { ...stats.summary(), ...capture.stats } } : {}) }
  } catch (error) {
    failed = true
    // A writer failure during cleanup must not replace the initiating failure.
    const failure = signal.aborted ? signal.reason : error
    const recordingTime = clock === undefined ? undefined : Math.max(0, secondsSince(clock))
    const [capturePath, screenshotPath] = await Promise.all([
      savePartialCapture(),
      // A frame size change or a capture write error also aborts signal; only caller cancellation skips this.
      config.runDirectory && page && !callerSignal?.aborted ? saveFailureScreenshot(page, files.screenshot, callerSignal) : undefined,
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
    GEOMETRY_CHECK_TIMEOUT,
    new TraceframeError(`Could not verify page geometry within ${GEOMETRY_CHECK_TIMEOUT / 1000} seconds. Make sure the page is responsive.`, { code: 'CAPTURE_SIZE_MISMATCH' }),
    signal,
  )
  if (width !== config.viewport.width || height !== config.viewport.height || scale !== 1 || left !== 0 || top !== 0) {
    throw new TraceframeError(`Page geometry is ${width}×${height} with visual scale ${scale} and offset ${left},${top}; expected ${config.viewport.width}×${config.viewport.height} with scale 1 and no offset. Use 100% browser zoom and an unscaled page, and keep its geometry fixed during recording.`, { code: 'CAPTURE_SIZE_MISMATCH' })
  }
}

// The JPEG width and height are undefined if the JPEG is unreadable.
function frameSize(frame) {
  const jpeg = jpegSize(frame.data)
  return { width: jpeg?.width, height: jpeg?.height, viewportWidth: frame.viewportWidth, viewportHeight: frame.viewportHeight }
}

function sameSize(a, b) {
  return a.width === b.width && a.height === b.height && a.viewportWidth === b.viewportWidth && a.viewportHeight === b.viewportHeight
}

function describeSize({ width, height, viewportWidth, viewportHeight }) {
  return `${width === undefined ? 'an unreadable JPEG' : `${width}×${height}`} for a ${viewportWidth}×${viewportHeight} viewport`
}

function assertFrameSize(frame, config) {
  // Check the exported JPEG dimensions; deviceScaleFactor alone is insufficient.
  const size = frameSize(frame)
  const expected = { width: config.video.width, height: config.video.height, viewportWidth: config.viewport.width, viewportHeight: config.viewport.height }
  if (!sameSize(size, expected)) {
    const scaleHint = config.scale === 2 ? ' For scale 2, launch Chromium with --force-device-scale-factor=2; deviceScaleFactor alone is insufficient.' : ''
    throw new TraceframeError(`Screencast frames are ${describeSize(size)}; expected ${describeSize(expected)}. Keep the viewport fixed and use the page exclusively for this recording.${scaleHint}`, { code: 'CAPTURE_SIZE_MISMATCH' })
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

async function saveFailureScreenshot(page, path, signal) {
  try {
    return await withDeadline(async (diagnosticSignal) => {
      const screenshot = await page.screenshot({ timeout: FAILURE_SCREENSHOT_TIMEOUT })
      diagnosticSignal.throwIfAborted()
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
