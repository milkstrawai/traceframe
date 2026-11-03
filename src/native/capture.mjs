import { addAbortListener } from 'node:events'
import { constants, rmSync } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { TraceframeError } from '../errors.mjs'
import { buildGrabber, createAuthority, INSTALL_HELP } from './setup.mjs'
import { deadline, describeExit, startProcess, stopProcess } from './process.mjs'
import { calibrateViewport, monitorPage } from './page.mjs'

const failure = (message, cause) => new TraceframeError(message, { code: 'NATIVE_CAPTURE_FAILED', cause })

export async function createNativeSession(config, signal, options) {
  // Before Playwright owns the browser, catch termination so Node runs the
  // compiler/session exit hooks. Explicit signal callers own their OS signals.
  const handlers = options.handleSignals ? Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }).map(([name, code]) => {
    const exit = () => process.exit(code)
    process.on(name, exit)
    return [name, exit]
  }) : []
  try { return await openSession(config, signal, options) }
  finally { for (const [name, exit] of handlers) process.off(name, exit) }
}

async function openSession(config, signal, { handleSignals, frameSyncOption }) {
  try { await access(config.browser ?? chromium.executablePath(), constants.X_OK) }
  catch (cause) { throw new TraceframeError(`Full Chromium is unavailable. ${INSTALL_HELP}`, { code: 'NATIVE_UNAVAILABLE', cause }) }
  const grabber = await buildGrabber(signal)
  const parent = ['--parent', String(process.pid)]
  // Linux-only: keep Chromium's singleton socket paths short even when the
  // caller's TMPDIR is long. All display/socket files share this private root.
  const directory = await mkdtemp('/tmp/tf-')
  const controller = new AbortController()
  const processes = new Set()
  let server, browser, sampler, encoder, displayProcess, pageMonitor, stopping = false
  let stopCapture, verifyPage
  const fail = (error) => { if (!stopping) controller.abort(error) }
  const watch = (process, name) => {
    processes.add(process)
    process.done.then((result) => {
      processes.delete(process)
      fail(failure(`${name} exited during native capture (${describeExit(result)}). ${process.stderr()}`, result.error))
    })
    return process
  }
  // The CLI's second Ctrl-C uses process.exit(), so it cannot await normal cleanup.
  const killOnExit = () => {
    for (const { child } of processes) child.kill('SIGKILL')
    if (server?.process().pid) { try { process.kill(-server.process().pid, 'SIGKILL') } catch {} }
    try { rmSync(directory, { recursive: true, force: true }) } catch {}
  }
  process.once('exit', killOnExit)
  async function closeBrowser() {
    if (!server) return
    try { await deadline(server.close(), 3_000, new Error('Browser shutdown timed out.')) }
    catch { await deadline(server.kill(), 3_000, new Error('Could not stop the native browser.')) }
  }
  async function close() {
    stopping = true
    controller.abort(failure('Native capture stopped.'))
    pageMonitor?.close()
    const results = await Promise.allSettled([...processes].filter((process) => process !== displayProcess).map((process) => stopProcess(process)))
    let cleanupError = results.find((result) => result.status === 'rejected')?.reason
    const remember = (error) => { cleanupError ??= error }
    await closeBrowser().catch(remember)
    if (displayProcess) await stopProcess(displayProcess).catch(remember)
    await rm(directory, { recursive: true, force: true }).catch(remember)
    process.removeListener('exit', killOnExit)
    if (cleanupError) throw cleanupError
  }
  try {
    const authority = join(directory, 'authority')
    await writeFile(authority, createAuthority(), { mode: 0o600 })
    const screen = { width: config.video.width + 256 * config.scale, height: config.video.height + 256 * config.scale }
    displayProcess = startProcess(grabber, [...parent, '--exec', 'Xvfb', '-displayfd', '1', '-screen', '0', `${screen.width}x${screen.height}x24`, '-auth', authority, '-nolisten', 'tcp', '-noreset'])
    processes.add(displayProcess)
    const displayReady = Promise.withResolvers()
    let output = ''
    displayProcess.child.stdout.on('data', (chunk) => {
      output += chunk
      if (/^\d+\n/.test(output)) displayReady.resolve(`:${output.trim()}`)
    })
    displayProcess.done.then((result) => displayReady.reject(new TraceframeError(`Could not start Xvfb (${describeExit(result)}). ${INSTALL_HELP}\n${displayProcess.stderr()}`, { code: 'NATIVE_UNAVAILABLE', cause: result.error })))
    const display = await deadline(displayReady.promise, 10_000, new TraceframeError('Xvfb did not start within 10 seconds.', { code: 'NATIVE_UNAVAILABLE' }), signal)
    watch(displayProcess, 'Xvfb')
    signal?.throwIfAborted()
    const env = { ...process.env, DISPLAY: display, XAUTHORITY: authority, TMPDIR: directory }
    delete env.WAYLAND_DISPLAY
    server = await chromium.launchServer({
      headless: false,
      channel: 'chromium',
      executablePath: config.browser,
      host: '127.0.0.1',
      artifactsDir: join(directory, 'artifacts'),
      env,
      args: [`--display=${display}`, '--ozone-platform=x11', `--force-device-scale-factor=${config.scale}`, '--kiosk', '--start-fullscreen', ...(config.nativeGpu === 'disabled' ? ['--disable-gpu'] : []), '--hide-scrollbars', '--mute-audio'],
      timeout: 10_000,
      handleSIGINT: handleSignals, handleSIGTERM: handleSignals, handleSIGHUP: handleSignals,
    }).catch((cause) => {
      throw new TraceframeError(`Could not launch full Chromium for native capture. ${INSTALL_HELP}\n${cause.message}`, { code: 'NATIVE_UNAVAILABLE', cause })
    })
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 10_000 })
    browser.on('disconnected', () => fail(failure('The native capture browser disconnected.')))
    signal?.throwIfAborted()
    return {
      browser,
      signal: controller.signal,
      close,
      verify: () => deadline(verifyPage(), 10_000, failure('The final native page geometry check timed out.')).catch((error) => {
        if (error instanceof TraceframeError) throw error
        throw failure(`Could not verify the captured page: ${error.message}`, error)
      }),
      async start(target, path, startupSignal) {
        const active = AbortSignal.any([startupSignal, controller.signal])
        active.throwIfAborted()
        const page = target
        const context = page.context()
        if (browser.contexts().flatMap((context) => context.pages()).length !== 1) throw failure('Native capture requires a single page on its private display.')
        const cdp = await context.newCDPSession(page)
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } })
        // Fullscreen can change Chromium's visible surface independently of emulation.
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...config.viewport, screenWidth: config.viewport.width, screenHeight: config.viewport.height, deviceScaleFactor: config.scale, mobile: false })
        const expectedBounds = (await cdp.send('Browser.getWindowBounds', { windowId })).bounds
        const expectedGeometry = [config.viewport.width, config.viewport.height, config.scale, 1, 0, 0, 'visible']
        const readGeometry = () => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio, visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop, document.visibilityState])
        const geometry = () => readGeometry().catch((error) => {
          // Navigation can replace the context during the final check; read the new document once.
          if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error
          return readGeometry()
        })
        if (JSON.stringify(await geometry()) !== JSON.stringify(expectedGeometry)) throw failure('The native page geometry does not match the recording settings.')
        const origin = await calibrateViewport(page, config.scale, async (width, height) => {
          const probe = startProcess(grabber, [...parent, '--locate', String(width), String(height), String(config.scale)], { env })
          processes.add(probe)
          let coordinates = ''
          probe.child.stdout.on('data', (chunk) => { coordinates += chunk })
          const result = await deadline(probe.done, 5_000, failure('Native viewport calibration timed out.'))
          processes.delete(probe)
          if (result.code !== 0) throw failure(`Could not locate the complete page viewport (${describeExit(result)}). ${probe.stderr()}`, result.error)
          return JSON.parse(coordinates)
        }, active)
        verifyPage = async () => {
          const [current, bounds] = await Promise.all([geometry(), cdp.send('Browser.getWindowBounds', { windowId }).then((result) => result.bounds)])
          if (JSON.stringify(current) !== JSON.stringify(expectedGeometry) || JSON.stringify(bounds) !== JSON.stringify(expectedBounds) || browser.contexts().flatMap((context) => context.pages()).length !== 1) {
            throw failure('The page geometry, visibility, or browser window changed during native capture.')
          }
        }
        pageMonitor = await monitorPage({ page, browser, cdp, verify: verifyPage, fail, signal: active })
        // A failed encoder must not expose a previous attempt's raw capture.
        await rm(path, { force: true })
        active.throwIfAborted()
        encoder = watch(startProcess(grabber, [...parent, '--exec', 'ffmpeg',
          '-y', '-hide_banner', '-loglevel', 'error', '-f', 'matroska', '-i', 'pipe:0',
          '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv444p', '-threads', '4', frameSyncOption, 'cfr', '-r', String(config.video.fps), '-f', 'matroska', path,
        ], { stdio: ['pipe', 'ignore', 'pipe'] }), 'The native encoder')
        encoder.child.stdin.on('error', (error) => fail(failure('The native encoder stopped accepting frames.', error)))
        sampler = watch(startProcess(grabber, [...parent, ...(config.nativeDiagnostics ? ['--diagnostics'] : []), String(config.video.width), String(config.video.height), String(origin.x), String(origin.y), String(config.video.fps)], { env, stdio: ['ignore', encoder.child.stdin, 'pipe'] }), 'The native sampler')
        const first = Promise.withResolvers()
        let metadata = ''
        const onFrame = (chunk) => {
          metadata += chunk
          const frame = /^FRAME (\d+\.\d+)\n/m.exec(metadata)
          if (frame) first.resolve({ timestamp: Number(frame[1]) })
        }
        sampler.child.stderr.on('data', onFrame)
        const aborted = () => first.reject(active.reason)
        const listener = addAbortListener(active, aborted)
        try { return await first.promise }
        finally {
          sampler.child.stderr.off('data', onFrame)
          listener[Symbol.dispose]()
        }
      },
      stop() {
        if (stopCapture) return stopCapture
        stopping = true
        pageMonitor?.close()
        stopCapture = (async () => {
          const sampled = await stopProcess(sampler)
          encoder.child.stdin.end()
          let encoded
          try { encoded = await deadline(encoder.done, 5_000, failure('The native encoder did not finish within 5 seconds.')) }
          catch (error) {
            const stopped = await stopProcess(encoder, 0)
            throw failure(`${error.message} Encoder: ${describeExit(stopped)}. ${encoder.stderr()}`, error)
          }
          if (sampled.forced || sampled.code !== 0 || encoded.code !== 0) throw failure(`Native capture did not finish successfully. Sampler: ${describeExit(sampled)}. ${sampler.stderr()} Encoder: ${describeExit(encoded)}. ${encoder.stderr()}`, sampled.error ?? encoded.error)
          if (config.nativeDiagnostics) {
            const line = /^STATS (.+)$/m.exec(sampler.stderr())
            if (!line) throw failure('The native sampler did not report capture diagnostics.')
            return { targetFps: config.video.fps, ...JSON.parse(line[1]) }
          }
        })()
        return stopCapture
      },
    }
  } catch (error) {
    await close().catch(() => {})
    signal?.throwIfAborted()
    throw error
  }
}
