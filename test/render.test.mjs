import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
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

test('draws captions over the page and under the click pulses and cursor', () => {
  const trace = { initialPointer: { x: 10, y: 20 }, moves: [{ at: 0, duration: 0.5, from: { x: 10, y: 20 }, to: { x: 50, y: 60 } }], clicks: [{ at: 1, point: { x: 50, y: 60 } }] }
  const captions = [{ path: 'one.png', start: 0.5, end: 1.5, x: 10, y: 20 }, { path: 'two.png', start: 2, end: 3.25, x: 30, y: 40 }]
  const script = buildFilterScript({ trace, scale: 1, fps: 60, audio: { offset: 0 }, captions, overlayEofAction: 'pass' })
  assert.match(script, /^\[0:v\][^;]*fps=60\[page0\];\[4:v\]format=yuva444p,setpts=PTS-STARTPTS\+0\.5\/TB\[caption0\];/)
  assert.match(script, /\[page0\]\[caption0\]overlay=x=10:y=20:eof_action=pass:format=yuv444:enable='between\(t,0\.5,1\.5\)'\[page1\]/)
  assert.match(script, /\[5:v\][^;]*\+2\/TB\[caption1\];\[page1\]\[caption1\]overlay=x=30:y=40:[^;]*'between\(t,2,3\.25\)'\[video0\]/)
  assert.ok(script.indexOf('[video0]') < script.indexOf('[click0]'))
  assert.match(script, /\[3:a:0\]/)
})

test('shows a caption only while its line is spoken', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-caption-'))
  try {
    const width = 160, height = 120, fps = 30
    const rawPath = join(directory, 'capture.mkv'), image = join(directory, 'caption.png'), white = join(directory, 'white.jpg')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${width}x${height}`, '-frames:v', '1', white])
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=40x20', '-frames:v', '1', image])
    const capture = createJpegCapture(rawPath, { width, height, fps, onError: assert.fail })
    await capture.append({ data: await readFile(white), timestamp: 1000 })
    await capture.stop(1900)
    const output = join(directory, 'output.mp4')
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg(),
      trace: { initialPointer: { x: 150, y: 110 }, moves: [], clicks: [], end: 0.9 },
      config: { video: { width, height, fps }, scale: 1, postRoll: 0, output },
      captions: [{ path: image, start: 0.3, end: 0.6, x: 30, y: 40 }],
    })
    const pixels = join(directory, 'pixels.gray')
    await runCommand('ffmpeg', ['-v', 'error', '-i', output, '-pix_fmt', 'gray', '-f', 'rawvideo', pixels])
    const frames = await readFile(pixels)
    const inside = (frame) => frames[frame * width * height + 50 * width + 50]
    const shown = Array.from({ length: frames.length / (width * height) }, (_, frame) => inside(frame) < 30)
    assert.deepEqual(shown.map((dark, frame) => dark ? frame : -1).filter((frame) => frame >= 0), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('turns the audio down under the narration while its lines are spoken', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-duck-'))
  try {
    const width = 160, height = 120, fps = 30, rate = 8000
    const rawPath = join(directory, 'capture.mkv'), white = join(directory, 'white.jpg')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${width}x${height}`, '-frames:v', '1', white])
    const capture = createJpegCapture(rawPath, { width, height, fps, onError: assert.fail })
    await capture.append({ data: await readFile(white), timestamp: 1000 })
    await capture.stop(5000)
    // A steady tone that starts half a second in, under a silent narration, so the tone's level is all there is.
    const tone = join(directory, 'tone.wav'), narration = join(directory, 'narration.wav')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', tone])
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', narration])
    const output = join(directory, 'output.mp4')
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg({ audio: true }),
      trace: { initialPointer: { x: 150, y: 110 }, moves: [], clicks: [], end: 4 },
      config: { video: { width, height, fps }, scale: 1, postRoll: 0, output },
      audio: { path: tone, offset: 0.5 },
      // Two lines half a second apart, then one more after a long pause.
      narration: { path: narration, spoken: [{ start: 1, end: 1.5 }, { start: 2, end: 2.4 }, { start: 3.4, end: 3.6 }] },
    })
    const pcm = join(directory, 'output.pcm')
    await runCommand('ffmpeg', ['-v', 'error', '-i', output, '-ac', '1', '-ar', String(rate), '-f', 's16le', pcm])
    const samples = new Int16Array((await readFile(pcm)).buffer)
    const level = (from, to) => Math.sqrt(samples.subarray(from * rate, to * rate).reduce((sum, value) => sum + value * value, 0) / ((to - from) * rate))
    const full = level(0.55, 0.75)
    assert.ok(full > 1000, `tone at ${full}`)
    assert.ok(level(0.1, 0.4) < 10)
    // Down through both lines and the short gap between them, back up after, and down again for the last line.
    for (const [from, to] of [[1.05, 1.45], [1.55, 1.95], [2.05, 2.35], [3.45, 3.55]]) {
      assert.ok(Math.abs(level(from, to) / full - 0.25) < 0.03, `${level(from, to) / full} of full from ${from} to ${to} s`)
    }
    assert.ok(Math.abs(level(2.65, 3.15) / full - 1) < 0.05)
    assert.ok(Math.abs(level(3.85, 4) / full - 1) < 0.05)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('full-range Chrome JPEGs retain gray levels and match limited-range input under overlays', async () => {
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
