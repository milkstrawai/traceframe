import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { buildFilterScript, renderVideo } from '../src/render.mjs'

test('stationary overlays preserve sparse image changes and post-roll at both scales and frame rates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-stationary-'))
  try {
    const ffmpeg = await probeFfmpeg()
    for (const scale of [1, 2]) {
      const width = 160 * scale, height = 120 * scale, images = []
      for (const level of ['0x404040', '0xc0c0c0']) {
        const path = join(directory, `${scale}-${level}.jpg`)
        await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${level}:s=${width}x${height}`, '-frames:v', '1', path])
        images.push(await readFile(path))
      }
      for (const fps of [30, 60]) {
        const rawPath = join(directory, `${scale}-${fps}.mkv`), output = join(directory, `${scale}-${fps}.mp4`)
        const capture = createJpegCapture(rawPath, { width, height, fps, onError: assert.fail })
        await capture.append({ data: images[0], timestamp: 1000 })
        await capture.append({ data: images[1], timestamp: 1370 })
        await capture.stop(1810)
        await renderVideo({ rawPath, directory, ffmpeg,
          trace: { initialPointer: { x: 40, y: 50 }, clicks: [], moves: [], end: 0.81 },
          config: { video: { width, height, fps }, scale, postRoll: 0.19, output },
        })
        const pixelsPath = join(directory, `${scale}-${fps}.gray`)
        await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-pix_fmt', 'gray', '-f', 'rawvideo', pixelsPath])
        const pixels = await readFile(pixelsPath), frameBytes = width * height, levels = []
        assert.equal(pixels.length, fps * frameBytes)
        for (let offset = 0; offset < pixels.length; offset += frameBytes) {
          levels.push(pixels[offset])
          assert.ok(pixels.subarray(offset, offset + frameBytes).some(value => value <= 3), 'cursor outline must remain visible')
          assert.ok(Math.abs(pixels[offset + 75 * scale * width + 60 * scale] - pixels[offset]) <= 3, 'cursor transparency must show the page')
        }
        const change = levels.findIndex(value => value > 128)
        assert.ok(Math.abs(change / fps - 0.37) <= 1 / fps, `image changed at ${change / fps}s`)
        assert.ok(levels.slice(0, change).every(value => Math.abs(value - 64) <= 3))
        assert.ok(levels.slice(change).every(value => Math.abs(value - 192) <= 3), 'post-roll must hold the last image')
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a click without cursor movement still animates between sparse captured frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-click-only-'))
  try {
    const image = join(directory, 'frame.jpg'), rawPath = join(directory, 'capture.mkv'), output = join(directory, 'output.mp4')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=160x120', '-frames:v', '1', image])
    const capture = createJpegCapture(rawPath, { width: 160, height: 120, fps: 60, onError: assert.fail })
    await capture.append({ data: await readFile(image), timestamp: 1000 })
    await capture.stop(2000)
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg(),
      trace: { initialPointer: { x: 20, y: 20 }, moves: [], clicks: [{ at: 0.2, point: { x: 110, y: 80 } }], end: 0.9 },
      config: { video: { width: 160, height: 120, fps: 60 }, scale: 1, postRoll: 0.1, output },
    })
    const pixelsPath = join(directory, 'pulse.gray')
    await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-vf', 'crop=40:40:90:60,format=gray', '-f', 'rawvideo', pixelsPath])
    const pixels = await readFile(pixelsPath), frameBytes = 40 * 40, frames = []
    assert.equal(pixels.length, 60 * frameBytes)
    for (let offset = 0; offset < pixels.length; offset += frameBytes) frames.push(pixels.subarray(offset, offset + frameBytes))
    assert.ok(frames.slice(0, 11).every(frame => frame.every(value => value >= 252)), 'pulse appeared before the click')
    assert.ok(frames.slice(12, 25).some(frame => frame.some(value => value < 240)), 'click pulse never appeared')
    assert.ok(new Set(frames.slice(12, 25).map(frame => frame.toString('base64'))).size > 6, 'pulse must animate on output frames')
    assert.ok(frames.slice(29).every(frame => frame.every(value => value >= 252)), 'pulse did not fade out')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a sparse static capture still renders a smoothly moving cursor at 60 FPS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-sparse-'))
  try {
    const image = join(directory, 'frame.jpg'), rawPath = join(directory, 'capture.mkv'), output = join(directory, 'output.mp4')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=640x120', '-frames:v', '1', image])
    const capture = createJpegCapture(rawPath, { width: 640, height: 120, fps: 60, onError: assert.fail })
    await capture.append({ data: await readFile(image), timestamp: 1000 })
    await capture.stop(2200)
    const initialPointer = { x: 20, y: 60 }
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg(),
      trace: { initialPointer, clicks: [], moves: [{ at: 0.1, duration: 0.8, from: initialPointer, to: { x: 600, y: 60 } }], end: 1.1 },
      config: { video: { width: 640, height: 120, fps: 60 }, scale: 1, postRoll: 0.1, output },
    })
    const pixelsPath = join(directory, 'cursor.gray')
    await runCommand('ffmpeg', ['-v', 'error', '-i', output, '-vf', 'crop=640:36:0:58,format=gray', '-f', 'rawvideo', pixelsPath])
    const pixels = await readFile(pixelsPath), frameBytes = 640 * 36, positions = []
    assert.equal(pixels.length / frameBytes, 72)
    for (let start = 0; start < pixels.length; start += frameBytes) {
      let left = 640
      for (let index = 0; index < frameBytes; index++) if (pixels[start + index] < 80) left = Math.min(left, index % 640)
      positions.push(left)
    }
    assert.ok(positions[0] < 25 && positions.at(-1) > 590)
    assert.ok(new Set(positions).size > 30, `Only ${new Set(positions).size} cursor positions were rendered`)
    assert.ok(positions.every((x, i) => i === 0 || x >= positions[i - 1]), 'cursor moved backwards')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an empty or sub-frame take contains at least one output frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-sparse-'))
  try {
    const rawPath = join(directory, 'capture.mkv'), image = join(directory, 'frame.jpg')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=8x8', '-frames:v', '1', image])
    const data = await readFile(image), ffmpeg = await probeFfmpeg()
    for (const fps of [30, 60]) {
      const capture = createJpegCapture(rawPath, { width: 8, height: 8, fps, onError: assert.fail })
      await capture.append({ data, timestamp: 1000 }); await capture.stop(1000)
      for (const end of [-0.000359, 0, 0.0005]) {
        const output = join(directory, 'output.mp4')
        const duration = await renderVideo({ rawPath, directory, ffmpeg,
          trace: { initialPointer: { x: 0, y: 0 }, clicks: [], moves: [], end },
          config: { video: { width: 8, height: 8, fps }, scale: 1, postRoll: 0, output },
        })
        assert.ok(duration >= 1 / fps - 0.000001 && duration <= 2 / fps + 0.000001)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a long static gap does not buffer a converted image for every output frame', { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-sparse-memory-'))
  let child, timer
  t.after(() => child?.kill('SIGKILL'))
  try {
    const image = join(directory, 'frame.jpg'), rawPath = join(directory, 'capture.mkv'), graph = join(directory, 'render.filter')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=640x480', '-frames:v', '1', image])
    const capture = createJpegCapture(rawPath, { width: 640, height: 480, fps: 60, onError: assert.fail })
    await capture.append({ data: await readFile(image), timestamp: 1000 })
    await capture.stop(61000)
    const ffmpeg = await probeFfmpeg()
    await writeFile(graph, buildFilterScript({ trace: { initialPointer: { x: 20, y: 20 }, moves: [{ at: 0.1, duration: 0.5, from: { x: 20, y: 20 }, to: { x: 300, y: 200 } }], clicks: [] }, scale: 1, fps: 60, overlayEofAction: ffmpeg.overlayEofAction }))
    child = spawn('ffmpeg', ['-v', 'error', '-i', rawPath, '-loop', '1', '-framerate', '60', '-i', join(import.meta.dirname, '../src/assets/cursor-1x.png'),
      ffmpeg.filterComplexFileOption, graph, '-map', '[final]', '-t', '60', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let peak = 0, exceeded = false, stderr = ''
    child.stderr.on('data', data => { stderr += data })
    // Stop a regression before it consumes gigabytes. RSS includes FFmpeg's
    // decoder and encoder; 512 MiB leaves ample room for this small fixture.
    timer = setInterval(async () => {
      const status = await readFile(`/proc/${child.pid}/status`, 'utf8').catch(() => '')
      peak = Math.max(peak, Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024)
      if (peak > 512 * 1024 * 1024) { exceeded = true; child.kill('SIGKILL') }
    }, 25)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(exceeded, false, `Sparse rendering exceeded 512 MiB (${Math.round(peak / 1024 / 1024)} MiB sampled).`)
    assert.equal(code, 0, stderr)
    assert.ok(peak > 0, 'FFmpeg memory must be sampled')
  } finally { clearInterval(timer); child?.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) }
})
