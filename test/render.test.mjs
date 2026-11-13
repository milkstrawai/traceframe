import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { buildFilterScript, renderVideo } from '../src/render.mjs'

test('draws one cursor segment per move and one pulse per click', () => {
  const trace = { initialPointer: { x: 10, y: 20 }, moves: [], clicks: [] }
  let from = trace.initialPointer
  for (let index = 0; index < 3; index += 1) {
    const to = { x: 100 + index * 10, y: 120 }
    trace.moves.push({ at: index, duration: 0.5, from, to })
    trace.clicks.push({ at: index + 0.75, point: to })
    from = to
  }
  const script = buildFilterScript({ trace, scale: 1, fps: 60, overlayEofAction: 'pass' })
  assert.match(script, /split=4\[cursor0\]\[cursor1\]\[cursor2\]\[cursor3\]/)
  assert.match(script, /\[2:v\]format=rgba,split=3\[pulse0\]\[pulse1\]\[pulse2\]/)
  assert.deepEqual(script.match(/\[click\d+\]overlay/g), ['[click0]overlay', '[click1]overlay', '[click2]overlay'])
  assert.match(script, /enable='between\(t,0\.75,0\.99\)'/)
  assert.match(script, /enable='gte\(t,0\)\*lt\(t,1\)'/)
  assert.equal(script.match(/:format=yuv444/g).length, script.match(/overlay=/g).length)
  assert.match(script, /\[final\]$/)
})

test('repeats the last raw frame when the screencast ends slightly before the post-roll', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-render-'))
  try {
    const video = { width: 320, height: 200, fps: 30 }
    const rawPath = join(directory, 'capture.webm')
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x200:r=30:d=1', '-c:v', 'libvpx-vp9', rawPath])
    const trace = { initialPointer: { x: 10, y: 20 }, moves: [], clicks: [], end: 1 }
    const duration = await renderVideo({
      rawPath,
      trace,
      directory,
      config: { video, scale: 1, postRoll: 0.1, output: join(directory, 'output.mp4') },
      ffmpeg: await probeFfmpeg(),
    })
    assert.ok(Math.abs(duration - 1.1) <= 1.5 / video.fps)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('full-range Chrome JPEGs retain gray levels and match limited-range input under overlays', async () => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { createJpegCapture } = await import('../src/jpeg-capture.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-levels-'))
  try {
    const width = 320, height = 200, fps = 30
    const levels = [0, 16, 32, 64, 128, 192, 235, 255]
    const rgb = Buffer.alloc(width * height * 3, 255)
    for (let y = 0; y < 80; y++) for (let x = 0; x < width; x++) {
      rgb.fill(levels[Math.floor(x / 40)], (y * width + x) * 3, (y * width + x) * 3 + 3)
    }
    const ppm = join(directory, 'levels.ppm'), jpg = join(directory, 'levels.jpg')
    await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]))
    await runCommand('ffmpeg', ['-v', 'error', '-i', ppm, '-pix_fmt', 'yuvj420p', '-q:v', '1', jpg])
    const rawPath = join(directory, 'capture.mkv')
    const capture = createJpegCapture(rawPath, { width, height, fps, onError: assert.fail })
    await capture.append({ data: await readFile(jpg), timestamp: 1000 })
    await capture.stop(1300)
    const limited = join(directory, 'limited.webm')
    await runCommand('ffmpeg', ['-v', 'error', '-loop', '1', '-i', ppm, '-t', '0.3', '-r', String(fps), '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-lossless', '1', limited])
    const ffmpeg = await probeFfmpeg(), decoded = []
    for (const [index, input] of [rawPath, limited].entries()) {
      const output = join(directory, `output-${index}.mp4`)
      await renderVideo({ rawPath: input, directory, ffmpeg,
        trace: { initialPointer: { x: 70, y: 120 }, moves: [], clicks: [{ at: 0.05, point: { x: 240, y: 140 } }], end: 0.2 },
        config: { video: { width, height, fps }, scale: 1, postRoll: 0.1, output },
      })
      const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range', '-of', 'json', output])
      assert.deepEqual(JSON.parse(stdout).streams[0], { pix_fmt: 'yuv420p', color_range: 'tv' })
      const pixelsPath = join(directory, `pixels-${index}.rgb`)
      await runCommand('ffmpeg', ['-v', 'error', '-i', output, '-ss', '0.1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixelsPath])
      const pixels = await readFile(pixelsPath)
      for (const [i, level] of levels.entries()) for (let channel = 0; channel < 3; channel++) {
        const actual = pixels[(20 * width + i * 40 + 20) * 3 + channel]
        assert.ok(Math.abs(actual - level) <= 3, `input ${index}, gray ${level} became ${actual}`)
      }
      let darkest = 255
      for (let y = 115; y < 155; y++) for (let x = 60; x < 100; x++) darkest = Math.min(darkest, pixels[(y * width + x) * 3])
      assert.ok(darkest <= 3, `black cursor became ${darkest}`)
      decoded.push(pixels)
    }
    // Compare cursor and click pixels with the established limited-range path.
    let error = 0, samples = 0
    for (let y = 100; y < height; y++) for (let x = 0; x < width * 3; x++) {
      error += Math.abs(decoded[0][y * width * 3 + x] - decoded[1][y * width * 3 + x]); samples++
    }
    assert.ok(error / samples < 2, `overlay mean RGB error ${error / samples}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
