import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { record } from '../src/index.mjs'
import { captureFlow } from '../src/capture.mjs'
import { createConfig } from '../src/config.mjs'
import { formatFailure } from '../src/diagnostics.mjs'
import { probeFfmpeg } from '../src/ffmpeg.mjs'
import { loadFlow } from '../src/flow.mjs'
import { createNativeSession } from '../src/native/capture.mjs'
import { buildGrabber } from '../src/native/setup.mjs'
import { deadline, startProcess, stopProcess } from '../src/native/process.mjs'

const run = promisify(execFile)
const enabled = process.env.TRACEFRAME_TEST_NATIVE === '1' && process.platform === 'linux'
const native = (name, fn) => test(name, { skip: !enabled, timeout: 90_000 }, fn)
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`

async function wrapCommand(t, directory, command, before) {
  const binary = (await run('which', [command])).stdout.trim()
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, command), `#!/bin/sh\n${before}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  t.after(() => { process.env.PATH = previous })
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-native-test-'))
  const temporary = join(directory, 'tmp')
  await mkdir(temporary)
  const previousTemp = process.env.TMPDIR
  process.env.TMPDIR = temporary
  t.after(async () => {
    if (previousTemp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTemp
    await rm(directory, { recursive: true, force: true })
  })
  const flow = join(directory, 'flow.mjs')
  await writeFile(flow, `let action, setup
export let initialPointer
export function configure(run, ready, pointer) { action = run; setup = ready; initialPointer = pointer }
export function ready(api) { return setup?.(api) }
export default function(api) { return action(api) }
`)
  const { configure } = await import(pathToFileURL(flow).href)
  const html = join(directory, 'page.html')
  await writeFile(html, '<button onclick="this.textContent=\'Saved\'">Save</button>')
  const options = { url: pathToFileURL(html).href, flow, capture: 'native', preset: 'draft', viewportWidth: 640, viewportHeight: 480, postRoll: 0.2, output: join(directory, 'video.mp4') }
  return { directory, temporary, configure, options }
}

async function ownedProcesses(page) {
  const cdp = await page.context().browser().newBrowserCDPSession()
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    const browser = processInfo.find((process) => process.type === 'browser').id
    // Chromium can rewrite /proc/cmdline as one space-delimited process title.
    const command = await readFile(`/proc/${browser}/cmdline`, 'utf8')
    const display = /(?:^|[\0 ])--display=(:\d+)(?:[\0 ]|$)/.exec(command)[1]
    // New Xvfb builds need not create .X*-lock files. Match the listening socket
    // to a direct child instead, without depending on library test hooks.
    const socketPath = `/tmp/.X11-unix/X${display.slice(1)}`
    const sockets = new Set((await readFile('/proc/net/unix', 'utf8')).trim().split('\n').filter((line) => line.endsWith(socketPath)).map((line) => line.trim().split(/\s+/)[6]))
    const rows = (await run('ps', ['-eo', 'pid=,ppid=,args='])).stdout.trim().split('\n')
    for (const row of rows) {
      const [, pid, parent, args] = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (+parent !== process.pid || !args.includes('-displayfd')) continue
      const files = await readdir(`/proc/${pid}/fd`)
      const links = await Promise.all(files.map((file) => readlink(`/proc/${pid}/fd/${file}`).catch(() => '')))
      if (!links.some((link) => sockets.has(/^socket:\[(\d+)\]$/.exec(link)?.[1]))) continue
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
      return { browser, xvfb: +pid, display, authority: argv[argv.indexOf('-auth') + 1] }
    }
    throw new Error('Could not identify the private Xvfb process.')
  } finally { await cdp.detach() }
}

async function assertClean(temporary, owned, extraPids = []) {
  assert.deepEqual(await readdir(temporary), [])
  for (const { authority } of owned) await assert.rejects(stat(dirname(authority)), { code: 'ENOENT' })
  for (const pid of [...owned.flatMap(({ browser, xvfb }) => [browser, xvfb]), ...extraPids]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

async function readFirstFrame(path) {
  return (await run('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
}

native('native recordings preserve all viewport edges, captions, audio, and both scales', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const sound = join(directory, 'tone.wav')
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', sound])
  const originalSound = await readFile(sound)
  for (const [scale, fps] of [[1, 30], [2, 60]]) {
    let owned, at, firstFrame, captionShownAt, captionDisposedAt, completed = 0
    configure(async ({ page, click, wait }) => {
      owned = await ownedProcesses(page)
      at = Date.now()
      const caption = await page.screencast.showOverlay('<div style="position:fixed;top:30px;left:100px;width:200px;height:60px;background:#123;color:white;pointer-events:none">Synthetic caption · اختبار<div style="position:absolute;left:8px;bottom:8px;width:16px;height:16px;background:#e040b0"></div></div>')
      captionShownAt = Date.now()
      await click(page.getByRole('button'), { duration: 0.1 })
      await page.getByRole('button', { name: 'Saved' }).waitFor()
      await wait(0.3)
      completed++
      await caption.dispose()
      captionDisposedAt = Date.now()
      await wait(0.3)
    }, async ({ page }) => {
      await page.addStyleTag({ content: 'body{margin:0}body::before{content:"";position:fixed;inset:0;border:4px solid;border-color:#f00 #ff0 #0f0 #00f;pointer-events:none}' })
    })
    const runDirectory = join(directory, `run-${scale}`)
    const summary = await record({ ...options, scale, fps, runDirectory, audio: async ({ startedAt }) => { firstFrame = startedAt; return { path: sound, offset: 0.1 } } })
    assert.equal(completed, 1)
    assert.ok(firstFrame <= at && at - firstFrame < 1_000)
    assert.equal(summary.audio, true)
    assert.equal(summary.clickCount, 1)
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', summary.output])).stdout)
    assert.deepEqual(probe.streams.map((stream) => stream.codec_name), ['h264', 'aac'])
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height, probe.streams[0].r_frame_rate], [640 * scale, 480 * scale, `${fps}/1`])
    // The cursor renderer also needs constant frame cadence, even on FFmpeg 5.
    const packets = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time', '-of', 'json', join(runDirectory, 'capture.mkv')])).stdout).packets
    assert.ok(packets.slice(1).every((packet, i) => Math.abs(Number(packet.pts_time) - Number(packets[i].pts_time) - 1 / fps) < 0.002))
    await run('ffmpeg', ['-v', 'error', '-xerror', '-i', summary.output, '-f', 'null', '-'])
    const frame = await readFirstFrame(join(runDirectory, 'capture.mkv'))
    const color = (x, y) => [...frame.subarray((y * 640 * scale + x) * 3, (y * 640 * scale + x) * 3 + 3)]
    for (const [x, y, expected] of [[320 * scale, 0, [255, 0, 0]], [320 * scale, 480 * scale - 1, [0, 255, 0]], [0, 240 * scale, [0, 0, 255]], [640 * scale - 1, 240 * scale, [255, 255, 0]]]) {
      assert.ok(color(x, y).every((value, i) => Math.abs(value - expected[i]) <= 4), `Clipped or corrupted edge at ${x},${y}: ${color(x, y)}`)
    }
    const shown = ((captionShownAt + captionDisposedAt) / 2 - firstFrame) / 1000
    const disposed = (captionDisposedAt - firstFrame) / 1000 + 0.15
    for (const path of [join(runDirectory, 'capture.mkv'), summary.output]) {
      for (const [time, expected] of [[shown, [224, 64, 176]], [disposed, [255, 255, 255]]]) {
        // Inspect an opaque patch inside the caption, away from text and the pointer.
        const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-ss', String(time), '-vf', `crop=${4 * scale}:${4 * scale}:${110 * scale}:${70 * scale}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })
        assert.equal(stdout.length, 4 * scale * 4 * scale * 3, 'The caption sample frame is missing.')
        assert.ok(stdout.every((value, i) => Math.abs(value - expected[i % 3]) <= 8), `Caption pixels differ at ${time}s in ${path}: expected ${expected}, got ${[...stdout.subarray(0, 3)]}.`)
      }
    }
    assert.deepEqual(await readFile(sound), originalSound)
    await assertClean(temporary, [owned])
  }
})

native('capture timestamps align content, clicks, and audio despite delayed or buffered encoder reads', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  await wrapCommand(t, directory, 'ffmpeg', 'case " $* " in *" -i pipe:0 "*) sleep 0.6;; esac')
  const sound = join(directory, 'tone.wav')
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.15', sound])
  await writeFile(join(directory, 'page.html'), '<style>html{background:black}body{margin:0}button{position:fixed;left:0;bottom:0;width:2px;height:2px;padding:0;border:0}</style><button onpointerdown="document.documentElement.style.background=\'white\';window.changedAt=Date.now()"></button>')
  for (const [width, height, scale, fps, pause] of [[8, 8, 1, 30, false], [1280, 800, 2, 60, false], [8, 8, 1, 30, true]]) {
    let owned, changedAt, offset
    configure(async ({ page, click, wait }) => {
      owned = await ownedProcesses(page)
      // Tiny frames fit in the pipe, so the flow can start before FFmpeg reads.
      await wait(pause ? 1 : 0.2)
      let encoder
      if (pause) {
        const rows = (await run('ps', ['-eo', 'pid=,ppid=,args='])).stdout.trim().split('\n')
        encoder = +rows.find((row) => row.includes(join(directory, 'run-8-true', 'capture.mkv')) && +row.trim().split(/\s+/)[1] === process.pid).trim().split(/\s+/)[0]
        process.kill(encoder, 'SIGSTOP')
        await wait(0.1)
      }
      try {
        await click(page.getByRole('button'), { duration: 0.03, dwell: 0 })
        changedAt = await page.evaluate(() => window.changedAt)
        if (pause) await wait(0.2)
      } finally { if (encoder) process.kill(encoder, 'SIGCONT') }
      await wait(0.3)
    }, undefined, { x: 0, y: height - 1 })
    const runDirectory = join(directory, `run-${width}-${pause}`)
    const summary = await record({ ...options, viewportWidth: width, viewportHeight: height, scale, fps, runDirectory,
      audio: async ({ startedAt }) => { offset = (changedAt - startedAt) / 1000; return { path: sound, offset } },
    })
    const filter = await readFile(join(runDirectory, 'render.filter'), 'utf8')
    const clickAt = Number(/\[pulse0\]setpts=PTS-STARTPTS\+([\d.]+)\/TB/.exec(filter)[1])
    assert.ok(Math.abs(clickAt - offset) < 0.05, 'Trace and audio clocks disagree.')
    for (const path of [join(runDirectory, 'capture.mkv'), summary.output]) {
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'crop=2:2:iw-2:0,format=gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
      let frame = 0
      while (frame * 4 < stdout.length && stdout[frame * 4] < 180) frame++
      assert.ok(frame * 4 < stdout.length, 'The visible action is missing.')
      assert.ok(Math.abs(frame / fps - clickAt) < 0.12, `Content/trace skew: ${frame / fps - clickAt}s (${width}px, paused=${pause}).`)
    }
    const pcm = (await run('ffmpeg', ['-v', 'error', '-i', summary.output, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout
    let sample = 0
    while (sample * 4 < pcm.length && Math.abs(pcm.readFloatLE(sample * 4)) < 0.02) sample++
    assert.ok(Math.abs(sample / 48000 - offset) < 0.03, 'The audio marker is misaligned.')
    await assertClean(temporary, [owned])
  }
})

native('calibration handles page styles, root zoom, forced colors, and strict CSP without leaving markers', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  for (const [scale, zoom, forcedColors, strictCsp] of [[1, 2, 'none', false], [2, 0.7, 'active', false], [1, 1, 'active', true]]) {
    const policy = strictCsp ? `<meta http-equiv="Content-Security-Policy" content="style-src 'none'">` : ''
    await writeFile(join(directory, 'page.html'), `${policy}<button onclick="this.textContent='Saved'">Save</button>`)
    let owned
    configure(async ({ page, click }) => {
      owned = await ownedProcesses(page)
      assert.equal(await page.locator('html > div').count(), 0)
      await click(page.getByRole('button'), { duration: 0.05 })
      await page.getByRole('button', { name: 'Saved' }).waitFor()
      assert.deepEqual(await page.evaluate(() => window.violations), [])
    }, async ({ page }) => {
      await page.evaluate((zoom) => {
        window.violations = []
        document.addEventListener('securitypolicyviolation', (event) => window.violations.push(event.violatedDirective))
        document.documentElement.style.zoom = zoom
      }, zoom)
      if (!strictCsp) await page.addStyleTag({ content: '::backdrop{background:rgba(0,0,0,.8)!important}div{filter:blur(10px)!important}' })
      await page.emulateMedia({ forcedColors })
    })
    const runDirectory = join(directory, `run-${scale}-${zoom}-${strictCsp}`)
    await record({ ...options, scale, runDirectory })
    const frame = await readFirstFrame(join(runDirectory, 'capture.mkv'))
    const width = 640 * scale, height = 480 * scale, size = 4 * scale
    assert.equal(frame.length, width * height * 3)
    // This fixture has neutral corners; either calibration pattern would add color.
    for (const [left, top] of [[0, 0], [width - size, height - size]]) {
      for (let y = top; y < top + size; y++) {
        for (let x = left; x < left + size; x++) {
          const rgb = frame.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)
          assert.ok(Math.max(...rgb) - Math.min(...rgb) <= 6, `Calibration pixels leaked into the first frame at ${x},${y}: ${[...rgb]}.`)
        }
      }
    }
    await assertClean(temporary, [owned])
  }
})

native('native Chromium stays on private X11 despite inherited Wayland settings and long temporary paths', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const server = createServer((socket) => { connections++; socket.destroy() })
  let connections = 0, owned
  const socket = join(directory, 'wayland-test')
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  const keys = ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'TMPDIR']
  const previous = keys.map((key) => process.env[key])
  const longTemporary = join(directory, 'long-temporary-'.repeat(5))
  await mkdir(longTemporary)
  try {
    Object.assign(process.env, { WAYLAND_DISPLAY: 'wayland-test', XDG_RUNTIME_DIR: directory, XDG_SESSION_TYPE: 'wayland', TMPDIR: longTemporary })
    configure(async ({ page, click }) => {
      owned = await ownedProcesses(page)
      const command = await readFile(`/proc/${owned.browser}/cmdline`, 'utf8')
      assert.match(command, /--ozone-platform=x11/)
      const environment = (await readFile(`/proc/${owned.browser}/environ`, 'utf8')).split('\0')
      assert.equal(environment.some((entry) => entry.startsWith('WAYLAND_DISPLAY=')), false)
      await click(page.getByRole('button'), { duration: 0.05 })
    })
    await record(options)
    assert.equal(connections, 0, 'Chromium contacted the external compositor.')
    assert.deepEqual(await readdir(longTemporary), [])
    await assertClean(temporary, [owned])
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
    await new Promise((resolve) => server.close(resolve))
  }
})

native('native capture follows full-page navigation without replaying mutations', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const next = join(directory, 'next.html')
  await writeFile(next, '<h1>Order summary</h1>')
  let mutations = 0, owned
  configure(async ({ page, click, wait }) => {
    owned = await ownedProcesses(page)
    await click(page.getByRole('button'), { duration: 0.1 })
    mutations++
    await page.goto(pathToFileURL(next).href)
    await page.getByRole('heading', { name: 'Order summary' }).waitFor()
    await wait(0.3)
  })
  await record(options)
  assert.equal(mutations, 1)
  await assertClean(temporary, [owned])
})

native('final native verification retries navigation context loss without accepting invalid geometry', async (t) => {
  const { directory, temporary, options } = await fixture(t)
  const config = createConfig(options)
  const signal = new AbortController().signal
  const session = await createNativeSession(config, signal, { ...await probeFfmpeg(), handleSignals: false })
  let owned
  try {
    const page = await session.browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale })
    await page.goto(options.url)
    owned = await ownedProcesses(page)
    await session.start(page, join(directory, 'capture.mkv'), signal)
    const evaluate = page.evaluate.bind(page)
    for (const [message, expectedReads] of [['Synthetic verification failure', 1], ['Execution context was destroyed', 2]]) {
      const reason = new Error(message)
      let reads = 0
      page.evaluate = async () => { reads++; throw reason }
      try {
        await assert.rejects(session.verify(), (error) => error.code === 'NATIVE_CAPTURE_FAILED' && error.cause === reason)
        assert.equal(reads, expectedReads)
      } finally { page.evaluate = evaluate }
    }
    const next = join(directory, 'next.html')
    await writeFile(next, '<h1>Order summary</h1>')
    for (const [message, resize] of [
      ['Execution context was destroyed, most likely because of a navigation', false],
      ['Cannot find context with specified id', false],
      ['Execution context was destroyed, most likely because of a navigation', true],
    ]) {
      // Invoke verify directly so a periodic poll cannot consume the injected error.
      page.evaluate = async () => {
        page.evaluate = evaluate
        await page.goto(pathToFileURL(next).href)
        if (resize) await page.setViewportSize({ width: 600, height: 480 })
        throw new Error(message)
      }
      if (resize) await assert.rejects(session.verify(), { code: 'NATIVE_CAPTURE_FAILED', message: /geometry/ })
      else await session.verify()
    }
    await session.stop()
  } finally { await session.close() }
  await assertClean(temporary, [owned])
})

native('native scrolling matches default viewport geometry at the full standard resolution', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  await writeFile(join(directory, 'page.html'), '<!doctype html><style>body{margin:0}main{width:2000px;height:2000px}</style><main><button onclick="this.textContent=\'Saved\'">Save</button></main>')
  for (const direction of ['ltr', 'rtl']) {
    let owned
    configure(async ({ page, click, wait }) => {
      owned = await ownedProcesses(page)
      assert.equal(await page.evaluate(() => document.documentElement.clientWidth === innerWidth && document.documentElement.clientHeight === innerHeight), true)
      const command = await readFile(`/proc/${owned.browser}/cmdline`, 'utf8')
      assert.match(command, /--mute-audio/)
      await click(page.getByRole('button'), { duration: 0.1 })
      await page.getByRole('button', { name: 'Saved' }).waitFor()
      await wait(0.2)
    }, ({ page }) => page.evaluate((direction) => { document.documentElement.dir = direction }, direction))
    const summary = await record({ ...options, viewportWidth: 1280, viewportHeight: 800, scale: 2, fps: 60 })
    assert.deepEqual([summary.width, summary.height, summary.fps], [2560, 1600, 60])
    await run('ffmpeg', ['-v', 'error', '-xerror', '-i', summary.output, '-f', 'null', '-'])
    await assertClean(temporary, [owned])
  }
})

native('native capture allows a busy page main thread without a spurious monitor timeout', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  let owned, blocked
  configure(async ({ page, wait }) => {
    owned = await ownedProcesses(page)
    await wait(0.3)
    blocked = await page.evaluate(() => {
      const start = Date.now(), end = performance.now() + 3_000
      while (performance.now() < end) {}
      return [start, Date.now()]
    })
    await wait(0.3)
  }, async ({ page }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<style>@keyframes slide{to{transform:translateX(120px)}}#motion{position:fixed;left:0;top:0;width:12px;height:12px;background:red;animation:slide 1s linear infinite alternate}</style><div id="motion"></div>')
    })
  })
  const config = createConfig(options)
  const flow = await loadFlow(config.flow, config.viewport)
  const { rawPath, startedAt, trace } = await captureFlow({ config, flow, ffmpeg: await probeFfmpeg(), directory })
  assert.ok(trace.end >= 3)
  const [start, end] = blocked.map((at) => (at - startedAt) / 1000)
  // Inspect only the interior of the blocked interval, allowing for boundary frames.
  const filter = `trim=start=${start + 0.25}:end=${end - 0.25},setpts=PTS-STARTPTS,crop=160:12:0:0`
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', rawPath, '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
  const positions = new Set()
  for (let frame = 0; frame < stdout.length; frame += 160 * 12 * 3) {
    for (let x = 0; x < 160; x++) {
      const pixel = frame + x * 3
      if (stdout[pixel] > 180 && stdout[pixel + 1] < 60 && stdout[pixel + 2] < 60) { positions.add(x); break }
    }
  }
  assert.ok(positions.size >= 3 && Math.max(...positions) - Math.min(...positions) > 10, 'Content did not move during the blocked interval.')
  await assertClean(temporary, [owned])
})

native('native display authentication rejects an unrelated local client', async (t) => {
  const { temporary, configure, options } = await fixture(t)
  const grabber = await buildGrabber()
  let owned
  configure(async ({ page, wait }) => {
    owned = await ownedProcesses(page)
    assert.equal((await stat(owned.authority)).mode & 0o777, 0o600)
    await assert.rejects(run(grabber, ['640', '480', '0', '0', '30'], { env: { ...process.env, DISPLAY: owned.display, XAUTHORITY: '/traceframe-nonexistent-authority' }, timeout: 3_000 }), (error) => /Cannot open the private X display/.test(error.stderr))
    await wait(0.1)
  })
  await record(options)
  await assertClean(temporary, [owned])
})

native('native cancellation during ready, capture, and post-roll preserves the exact reason and prior output', async (t) => {
  const { temporary, configure, options } = await fixture(t)
  for (const phase of ['ready', 'capture', 'post-roll']) {
    const controller = new AbortController()
    const reason = new Error(`Synthetic ${phase} interruption`)
    let owned
    configure(async ({ wait }) => {
      if (phase === 'post-roll') { setTimeout(() => controller.abort(reason), 30); return }
      controller.abort(reason)
      await wait(30)
    }, async ({ page }) => {
      owned = await ownedProcesses(page)
      if (phase === 'ready') { controller.abort(reason); await new Promise(() => {}) }
    })
    await writeFile(options.output, 'prior output')
    await assert.rejects(record({ ...options, postRoll: 5, signal: controller.signal }), (error) => error === reason)
    assert.equal(await readFile(options.output, 'utf8'), 'prior output')
    await assertClean(temporary, [owned])
  }
})

native('cancellation before Xvfb readiness promptly stops the child and removes its private directory', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const allocation = join(directory, 'display-allocation')
  await wrapCommand(t, directory, 'Xvfb', `printf '%s\\n' "$$" "$@" > ${quote(`${allocation}.tmp`)}\nmv ${quote(`${allocation}.tmp`)} ${quote(allocation)}\nexec ${quote(process.execPath)} -e 'setInterval(() => {}, 1000)'`)
  configure(() => assert.fail('The cancelled flow must not run.'))
  await writeFile(options.output, 'prior output')
  const controller = new AbortController()
  const reason = new Error('Synthetic display-startup interruption')
  const capture = record({ ...options, signal: controller.signal })
  capture.catch(() => {})
  try {
    const readyBy = performance.now() + 5_000
    let allocated
    while (!allocated && performance.now() < readyBy) {
      allocated = await readFile(allocation, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error })
      if (!allocated) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(allocated, 'The synthetic display did not start.')
    const [pid, ...args] = allocated.trim().split('\n')
    const abortedAt = performance.now()
    controller.abort(reason)
    await assert.rejects(capture, (error) => error === reason)
    const elapsed = performance.now() - abortedAt
    assert.ok(elapsed < 2_000, `Cancellation took ${elapsed.toFixed(0)}ms while waiting for display readiness.`)
    assert.throws(() => process.kill(+pid, 0), { code: 'ESRCH' })
    await assert.rejects(stat(dirname(args[args.indexOf('-auth') + 1])), { code: 'ENOENT' })
    assert.equal(await readFile(options.output, 'utf8'), 'prior output')
    await assertClean(temporary, [])
  } finally {
    controller.abort(reason)
    await capture.catch(() => {})
  }
})

native('a cancelled native startup cannot start capture processes after cleanup', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const controller = new AbortController()
  const reason = new Error('Synthetic startup interruption')
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let owned
  configure(() => assert.fail('The cancelled flow must not run.'), async ({ page }) => {
    owned = await ownedProcesses(page)
    const browser = page.context().browser()
    const original = browser.newBrowserCDPSession.bind(browser)
    browser.newBrowserCDPSession = async () => {
      const session = await original()
      const send = session.send.bind(session)
      session.send = async (method, ...args) => {
        const result = await send(method, ...args)
        if (method === 'Target.setDiscoverTargets') { entered.resolve(); await release.promise }
        return result
      }
      return session
    }
  })
  const runDirectory = join(directory, 'run')
  const rejected = assert.rejects(record({ ...options, runDirectory, signal: controller.signal }), (error) => error === reason)
  try {
    await Promise.race([entered.promise, rejected.then(() => assert.fail('Startup never reached target discovery.'))])
    controller.abort(reason)
    await rejected
  } finally { release.resolve() }
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(await readdir(runDirectory), [])
  await assertClean(temporary, [owned])
})

native('native CLI Ctrl-C saves a partial capture and a second Ctrl-C kills owned processes', async (t) => {
  const { directory, temporary, options } = await fixture(t)
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname
  for (const force of [false, true]) {
    const runDirectory = join(directory, force ? 'forced' : 'interrupted')
    const pids = join(directory, 'pids.json')
    await writeFile(options.flow, `import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export default async ({ page, wait }) => {
  const session = await page.context().browser().newBrowserCDPSession()
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  const browser = processInfo.find(p => p.type === 'browser').id
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,args='])
  const children = stdout.trim().split('\\n').map(row => row.trim().split(/\\s+/)).filter(row => +row[1] === process.pid).map(row => +row[0])
  const directories = []
  for (const child of children) {
    const args = (await readFile('/proc/' + child + '/cmdline', 'utf8').catch(() => '')).split('\\0')
    if (args.includes('-auth')) directories.push(dirname(args[args.indexOf('-auth') + 1]))
  }
  await writeFile(${JSON.stringify(pids)}, JSON.stringify({ pids: [browser, ...children], directories }))
  await wait(0.2)
  process.kill(process.pid, 'SIGINT')
  if (${force}) setTimeout(() => process.kill(process.pid, 'SIGINT'), 5)
  await new Promise(() => {})
}`)
    let result
    try {
      await run(process.execPath, [cli, 'record', '--capture', 'native', '--url', options.url, '--flow', options.flow,
        '--preset', 'draft', '--viewport-width', '640', '--viewport-height', '480', '--run-dir', runDirectory, '--out', options.output], { timeout: 20_000 })
      assert.fail('The interrupted CLI must reject.')
    } catch (error) { result = error }
    assert.equal(result.code, 130)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Stopping and cleaning up/)
    assert.doesNotMatch(result.stderr, /FLOW_FAILED|Screenshot:/)
    if (!force) {
      assert.match(result.stderr, /Recording was interrupted/)
      await run('ffmpeg', ['-v', 'error', '-xerror', '-i', join(runDirectory, 'capture.mkv'), '-f', 'null', '-'])
    }
    assert.deepEqual(await readdir(temporary), [])
    const resources = JSON.parse(await readFile(pids, 'utf8'))
    assert.equal(resources.directories.length, 1)
    for (const directory of resources.directories) await assert.rejects(stat(directory), { code: 'ENOENT' })
    const exitedBy = performance.now() + 1_000
    for (const pid of resources.pids) {
      // A forced exit may leave children for the host's init to reap, but none may run.
      let status
      while (true) {
        status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        if (!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z ') || performance.now() >= exitedBy) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
      assert.ok(!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z '), `Process ${pid} survived Ctrl-C: ${status}; ${command.replaceAll('\0', ' ')}`)
    }
  }
})

native('native capture rejects changed geometry, popups, and a closed target', async (t) => {
  const { temporary, configure, options } = await fixture(t)
  for (const change of [
    (page) => page.setViewportSize({ width: 600, height: 480 }),
    async (page) => { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 }); await cdp.detach() },
    (page) => page.evaluate(() => window.open('about:blank', '_blank')),
    async (page) => { const context = await page.context().browser().newContext(); await context.newPage() },
    (page) => page.close(),
  ]) {
    let owned
    configure(async ({ page, wait }) => {
      owned = await ownedProcesses(page)
      await change(page)
      await wait(2)
    })
    await writeFile(options.output, 'prior output')
    await assert.rejects(record(options), { code: 'NATIVE_CAPTURE_FAILED' })
    assert.equal(await readFile(options.output, 'utf8'), 'prior output')
    await assertClean(temporary, [owned])
  }
})

native('native capture checks a geometry change at the very end of a flow with no post-roll', async (t) => {
  const { temporary, configure, options } = await fixture(t)
  let owned
  configure(async ({ page }) => {
    owned = await ownedProcesses(page)
    await page.setViewportSize({ width: 600, height: 480 })
  })
  await assert.rejects(record({ ...options, postRoll: 0 }), { code: 'NATIVE_CAPTURE_FAILED' })
  await assertClean(temporary, [owned])
})

native('native encoder startup exits reject without exposing previous captures', async (t) => {
  for (const [name, terminate, message] of [
    ['nonzero exit', 'exit 23', /native encoder.*exit code 23/],
    ['signal exit', 'kill -KILL "$$"', /native encoder.*signal SIGKILL/],
  ]) {
    await t.test(name, async (t) => {
      const { directory, temporary, configure, options } = await fixture(t)
      await wrapCommand(t, directory, 'ffmpeg', `case " $* " in *' -f matroska -i pipe:0 '*) ${terminate} ;; esac`)
      const runDirectory = join(directory, 'run')
      const rawPath = join(runDirectory, 'capture.mkv')
      await mkdir(runDirectory)
      await writeFile(rawPath, 'capture from an earlier attempt')
      let owned
      configure(() => assert.fail('The failed encoder must not start the flow.'), async ({ page }) => { owned = await ownedProcesses(page) })
      await writeFile(options.output, 'prior output')
      await assert.rejects(record({ ...options, runDirectory }), (error) => {
        assert.equal(error.code, 'NATIVE_CAPTURE_FAILED')
        // The encoder exit and the resulting sampler EPIPE can arrive in either order.
        assert.ok(message.test(formatFailure(error)) || /native sampler[\s\S]*Broken pipe/.test(formatFailure(error)), formatFailure(error))
        assert.equal(error.diagnostics?.capturePath, undefined)
        return true
      })
      await assert.rejects(stat(rawPath), { code: 'ENOENT' })
      assert.equal(await readFile(options.output, 'utf8'), 'prior output')
      await assertClean(temporary, [owned])
    })
  }
})

native('native capture detects display and encoder exits, clean sampler exits, and stalled workers', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const runDirectory = join(directory, 'run')
  const rawPath = join(runDirectory, 'capture.mkv')
  for (const fault of ['display', 'encoder', 'sampler', 'stalled-encoder', 'stalled-sampler']) {
    let owned, capturePids
    configure(async ({ page, wait }) => {
      owned = await ownedProcesses(page)
      const rows = (await run('ps', ['-eo', 'pid=,ppid=,args='])).stdout.trim().split('\n').map((row) => { const [, pid, parent, args] = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return { pid: +pid, parent: +parent, args } })
      const encoder = rows.find((row) => row.parent === process.pid && row.args.includes(join(directory, 'run', 'capture.mkv')))
      const sampler = rows.find((row) => row.parent === process.pid && /\/grab --parent \d+ \d+ \d+ \d+ \d+ (30|60)$/.test(row.args))
      assert.ok(encoder && sampler)
      capturePids = [encoder.pid, sampler.pid]
      await wait(0.1)
      const pid = fault === 'display' ? owned.xvfb : fault.includes('sampler') ? sampler.pid : encoder.pid
      process.kill(pid, fault.startsWith('stalled-') ? 'SIGSTOP' : fault === 'sampler' ? 'SIGTERM' : 'SIGKILL')
      await wait(fault.startsWith('stalled-') ? 0.2 : 2)
    })
    await writeFile(options.output, 'prior output')
    const start = performance.now()
    await assert.rejects(record({ ...options, runDirectory }), (error) => {
      assert.equal(error.code, 'NATIVE_CAPTURE_FAILED')
      const message = formatFailure(error)
      if (fault === 'encoder') assert.match(message, /native encoder.*signal SIGKILL|native sampler[\s\S]*Broken pipe/)
      if (fault === 'sampler') assert.match(message, /native sampler.*exit code 0/)
      if (fault.startsWith('stalled-')) assert.match(message, /signal SIGKILL.*forced termination/)
      if (fault === 'display' || fault === 'stalled-sampler') {
        assert.equal(error.diagnostics.capturePath, rawPath)
        assert.ok(message.includes(`  Capture: ${rawPath}\n`))
      }
      return true
    })
    assert.ok(performance.now() - start < 20_000, 'Native capture shutdown exceeded its bound.')
    assert.equal(await readFile(options.output, 'utf8'), 'prior output')
    if (fault === 'display' || fault === 'stalled-sampler') await run('ffmpeg', ['-v', 'error', '-xerror', '-i', rawPath, '-f', 'null', '-'])
    await assertClean(temporary, [owned], capturePids)
  }
})

native('native launch failures clean up the private display before any flow action', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const allocation = join(directory, 'display-allocation')
  await wrapCommand(t, directory, 'Xvfb', `printf '%s\\n' "$$" "$@" > ${quote(allocation)}`)
  let called = false
  configure(() => { called = true })
  await assert.rejects(record({ ...options, browser: '/traceframe-missing-chromium' }), { code: 'NATIVE_UNAVAILABLE' })
  await assert.rejects(readFile(allocation), { code: 'ENOENT' })
  await assert.rejects(record({ ...options, browser: '/bin/false' }), (error) => error.code === 'NATIVE_UNAVAILABLE' && /Could not launch full Chromium/.test(error.message))
  const [pid, ...args] = (await readFile(allocation, 'utf8')).trim().split('\n')
  assert.throws(() => process.kill(+pid, 0), { code: 'ESRCH' })
  await assert.rejects(stat(dirname(args[args.indexOf('-auth') + 1])), { code: 'ENOENT' })
  assert.equal(called, false)
  await assertClean(temporary, [])
})

native('two native recordings use different displays and retain their own page state', async (t) => {
  const { directory, temporary, configure, options } = await fixture(t)
  const displays = new Set(), captures = []
  let completed = 0
  configure(async ({ page, click, wait }) => {
    const owned = await ownedProcesses(page)
    displays.add(owned.display)
    captures.push(owned)
    await click(page.getByRole('button'), { duration: 0.1 })
    await page.getByRole('button', { name: 'Saved' }).waitFor()
    await wait(0.1)
    completed++
  })
  const summaries = await Promise.all([record(options), record({ ...options, output: join(directory, 'second.mp4') })])
  assert.equal(displays.size, 2)
  assert.equal(completed, 2)
  assert.equal(summaries.length, 2)
  await assertClean(temporary, captures)
})

async function childMessage(child) {
  return deadline(Promise.race([
    new Promise((resolve) => child.child.once('message', resolve)),
    child.done.then((result) => { throw new Error(`Test caller exited before its checkpoint: ${JSON.stringify(result)} ${child.stderr()}`) }),
  ]), 10_000, new Error('Test caller did not reach its checkpoint.'))
}

async function assertExited(pids) {
  for (const pid of pids) {
    const end = performance.now() + 3_000
    while (true) {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error })
      // An abruptly terminated owner cannot reap children; init may still be doing so.
      if (!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')) break
      assert.ok(performance.now() < end, `Process ${pid} survived owner termination.`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

native('default API termination before browser launch stops the ready display', async (t) => {
  const { options } = await fixture(t)
  const caller = startProcess(process.execPath, ['--input-type=module', '-e', `
    import { chromium } from 'playwright'
    import { execFile } from 'node:child_process'
    import { promisify } from 'node:util'
    import { record } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}
    chromium.launchServer = async ({ env }) => {
      const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,args='])
      const row = stdout.split('\\n').find(row => +row.trim().split(/\\s+/)[1] === process.pid && row.includes(env.XAUTHORITY))
      process.send({ directory: env.TMPDIR, pid: +row.trim().split(/\\s+/)[0] })
      await new Promise(() => {})
    }
    await record(${JSON.stringify(options)})
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let owned
  try {
    owned = await childMessage(caller)
    process.kill(owned.pid, 0)
    caller.child.kill('SIGTERM')
    assert.equal((await deadline(caller.done, 3_000, new Error('Startup did not stop.'))).code, 143, caller.stderr())
    await assertExited([owned.pid])
    await assert.rejects(stat(owned.directory), { code: 'ENOENT' })
  } finally {
    await stopProcess(caller, 0)
    if (owned) {
      try { process.kill(owned.pid, 'SIGKILL') } catch {}
      await rm(owned.directory, { recursive: true, force: true })
    }
  }
})

native('forced exit during final session-directory removal retains the cleanup fallback', async (t) => {
  const { options } = await fixture(t)
  // Nested Playwright directories must not be mistaken for the session root.
  const browserTemp = await mkdtemp('/tmp/tf-cleanup-test-')
  t.after(() => rm(browserTemp, { recursive: true, force: true }))
  const caller = startProcess(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'
    import { dirname } from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    import { createConfig } from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)}
    import { createNativeSession } from ${JSON.stringify(new URL('../src/native/capture.mjs', import.meta.url).href)}
    const remove = fs.rm
    fs.rm = async (path, options) => {
      if (dirname(String(path)) === '/tmp' && String(path).startsWith('/tmp/tf-')) {
        process.send({ directory: path })
        await new Promise(() => {})
      }
      return remove(path, options)
    }
    syncBuiltinESMExports()
    process.on('message', () => process.exit(130))
    const session = await createNativeSession(createConfig(${JSON.stringify(options)}), undefined, { handleSignals: false })
    await session.close()
  `], { env: { ...process.env, TMPDIR: browserTemp }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let owned
  try {
    owned = await childMessage(caller)
    assert.ok((await stat(join(owned.directory, 'authority'))).size > 0)
    caller.child.send('force exit')
    assert.equal((await deadline(caller.done, 3_000, new Error('Forced exit did not settle.'))).code, 130, caller.stderr())
    await assert.rejects(stat(owned.directory), { code: 'ENOENT' })
  } finally {
    await stopProcess(caller, 0)
    if (owned) await rm(owned.directory, { recursive: true, force: true })
  }
})

native('owner death stops the display, sampler and encoder, including stopped workers', async (t) => {
  const { directory, options } = await fixture(t)
  await writeFile(options.flow, `import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
const run = promisify(execFile)
${ownedProcesses.toString()}
export default async ({ page, wait }) => {
  const owned = await ownedProcesses(page)
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,args='])
  const children = stdout.trim().split('\\n').map(row => row.trim().split(/\\s+/)).filter(row => +row[1] === process.pid && row[2] !== 'ps')
  process.send({ ...owned, pids: children.map(row => +row[0]), workers: children.filter(row => /\\/(grab|ffmpeg)$/.test(row[2]) || row[2] === 'ffmpeg').map(row => +row[0]) })
  await wait(30)
}
`)
  for (const [kind, signal, stalled] of [['cli', 'SIGKILL', false], ['api', 'SIGTERM', false], ['cli', 'SIGKILL', true]]) {
    const runDirectory = join(directory, `${kind}-${stalled}`)
    const args = kind === 'cli'
      ? [new URL('../src/cli.mjs', import.meta.url).pathname, 'record', '--capture', 'native', '--url', options.url, '--flow', options.flow, '--preset', 'draft', '--run-dir', runDirectory, '--out', options.output]
      : ['--input-type=module', '-e', `import { record } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}; await record({ ...${JSON.stringify(options)}, runDirectory: ${JSON.stringify(runDirectory)}, signal: new AbortController().signal })`]
    const caller = startProcess(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let owned
    try {
      owned = await childMessage(caller)
      assert.equal(owned.workers.length, 2)
      if (stalled) for (const pid of owned.workers) process.kill(pid, 'SIGSTOP')
      caller.child.kill(signal)
      assert.equal((await deadline(caller.done, 3_000, new Error('Owner did not exit.'))).signal, signal, caller.stderr())
      await assertExited(owned.pids)
      const rawPath = join(runDirectory, 'capture.mkv')
      const size = (await stat(rawPath)).size
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal((await stat(rawPath)).size, size, 'Capture kept growing after its owner died.')
    } finally {
      await stopProcess(caller, 0)
      if (owned) {
        for (const pid of owned.pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
        await rm(dirname(owned.authority), { recursive: true, force: true })
      }
    }
  }
})

native('the helper refuses to start a worker when its expected owner is already gone', async (t) => {
  const { directory } = await fixture(t)
  const marker = join(directory, 'unexpected-worker')
  const grabber = await buildGrabber()
  await assert.rejects(run(grabber, ['--parent', String(process.pid + 1), '--exec', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`]), { code: 1 })
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})
