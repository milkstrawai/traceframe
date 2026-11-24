import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { easeOutCubic } from '../src/easing.mjs'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { renderVideo } from '../src/render.mjs'

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

test('frames near output-frame boundaries keep their own output frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-boundary-'))
  try {
    const rawPath = join(directory, 'capture.mkv'), output = join(directory, 'output.mp4'), images = []
    for (const level of ['0x202020', '0x808080', '0xe0e0e0']) {
      const path = join(directory, `${level}.jpg`)
      await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${level}:s=64x48`, '-frames:v', '1', path])
      images.push(await readFile(path))
    }
    // At 60 FPS these land in output frames 2 and 4. Rounded to 42 and 58 ms, both would land in frame 3.
    const capture = createJpegCapture(rawPath, { width: 64, height: 48, fps: 60, onError: assert.fail })
    for (const [index, timestamp] of [1000, 1041.6, 1058.4].entries()) await capture.append({ data: images[index], timestamp })
    await capture.stop(1100)
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg(),
      trace: { initialPointer: { x: 60, y: 44 }, clicks: [], moves: [], end: 0.08 },
      config: { video: { width: 64, height: 48, fps: 60 }, scale: 1, postRoll: 0.02, output },
    })
    const pixelsPath = join(directory, 'levels.gray')
    await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-vf', 'crop=8:8:0:0,format=gray', '-f', 'rawvideo', pixelsPath])
    const pixels = await readFile(pixelsPath), frameBytes = 8 * 8, pictures = []
    // Gray levels 32, 128 and 224 identify pictures 0, 1 and 2.
    for (let offset = 0; offset < pixels.length; offset += frameBytes) pictures.push(Math.round(pixels[offset] / 96))
    assert.deepEqual(pictures, [0, 0, 1, 1, 2, 2])
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
    const move = { at: 0.1, duration: 0.8, from: initialPointer, to: { x: 600, y: 60 } }
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg(),
      trace: { initialPointer, clicks: [], moves: [move], end: 1.1 },
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
    // The drawn cursor must follow the curve the browser pointer moved along.
    positions.forEach((left, frame) => {
      const progress = Math.min(1, Math.max(0, (frame / 60 - move.at) / move.duration))
      const expected = positions[0] + (move.to.x - move.from.x) * easeOutCubic(progress)
      assert.ok(Math.abs(left - expected) <= 2, `frame ${frame}: cursor at ${left}, expected ${expected.toFixed(1)}`)
    })
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
      const pointer = { x: 0, y: 0 }
      const move = { at: 0, duration: 1 / fps, from: pointer, to: { x: 4, y: 4 } }
      for (const [end, moves] of [[-0.000359, []], [0, []], [0.0005, []], [0.0005, [move]]]) {
        const output = join(directory, 'output.mp4')
        const duration = await renderVideo({ rawPath, directory, ffmpeg, signal: AbortSignal.timeout(10_000),
          trace: { initialPointer: pointer, clicks: [], moves, end },
          config: { video: { width: 8, height: 8, fps }, scale: 1, postRoll: 0, output },
        })
        assert.ok(duration >= 1 / fps - 0.000001 && duration <= 2 / fps + 0.000001)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

const memoryTest = { skip: process.platform !== 'linux', timeout: 30_000 }
const initialPointer = { x: 20, y: 20 }

test('a long static gap does not buffer a converted image for every output frame', memoryTest, async (t) => {
  const move = { at: 0.1, duration: 0.5, from: initialPointer, to: { x: 300, y: 200 } }
  await checkRenderMemory(t, { end: 60, moves: [move], clicks: [], burstStarts: [] })
})

test('render memory stays bounded across a long hold followed by clicks', memoryTest, async (t) => {
  const clicks = [21.2, 24.3, 27.4, 31.5].map(at => ({ at, point: { x: 100, y: 100 } }))
  await checkRenderMemory(t, { end: 33, moves: [], clicks, burstStarts: [20, 25, 32] })
})

async function checkRenderMemory(t, { end, moves, clicks, burstStarts }) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-sparse-memory-'))
  const controller = new AbortController()
  let timer, peak = 0
  try {
    const image = join(directory, 'frame.jpg'), rawPath = join(directory, 'capture.mkv')
    const video = { width: 640, height: 360, fps: 60 }
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=640x360', '-frames:v', '1', image])
    const data = await readFile(image)
    const capture = createJpegCapture(rawPath, { ...video, onError: assert.fail })
    await capture.append({ data, timestamp: 0 })
    for (const start of burstStarts) {
      for (let frame = 0; frame < 32; frame++) await capture.append({ data, timestamp: 1000 * (start + frame / video.fps) })
    }
    await capture.stop(end * 1000)

    const ffmpeg = await probeFfmpeg()
    // Sample the real renderer and stop a regression before it fills the host.
    timer = setInterval(async () => {
      const children = await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')
      for (const pid of children.match(/\d+/g) ?? []) {
        const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
        if (!/^Name:\s+ffmpeg$/m.test(status)) continue
        peak = Math.max(peak, Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) / 1024)
        if (peak > 512) controller.abort()
      }
    }, 25)
    const duration = await renderVideo({ rawPath, directory, ffmpeg, signal: AbortSignal.any([t.signal, controller.signal]),
      trace: { initialPointer, moves, clicks, end },
      config: { video, scale: 1, postRoll: 0, output: join(directory, 'output.mp4') },
    })
    assert.equal(duration, end)
    assert.ok(peak > 0, 'FFmpeg memory must be sampled')
  } finally {
    clearInterval(timer)
    await rm(directory, { recursive: true, force: true })
    assert.ok(peak <= 512, `Sparse rendering exceeded 512 MiB (${Math.round(peak)} MiB sampled).`)
  }
}
