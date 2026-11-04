import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { buildFilterScript, renderVideo } from '../src/render.mjs'

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
    await writeFile(graph, buildFilterScript({ trace: { initialPointer: { x: 20, y: 20 }, moves: [], clicks: [] }, scale: 1, fps: 60, overlayEofAction: ffmpeg.overlayEofAction }))
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
