import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
import { buildRenderFilters, duckUnderVoice, renderVideo } from '../src/render.mjs'

test('draws one cursor segment per move and one pulse per click', () => {
  const trace = { initialPointer: { x: 10, y: 20 }, moves: [], clicks: [] }
  let from = trace.initialPointer
  for (let index = 0; index < 3; index += 1) {
    const to = { x: 100 + index * 10, y: 120 }
    trace.moves.push({ at: index, duration: 0.5, from, to })
    trace.clicks.push({ at: index + 0.75, point: to })
    from = to
  }
  const { script } = buildRenderFilters({ rawPath: 'capture.mkv', trace, scale: 1, fps: 60, overlayEofAction: 'pass' })
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
  const { captureGraph, script } = buildRenderFilters({ rawPath: 'capture.mkv', trace, scale: 1, fps: 60, audio: { offset: 0 }, captions, overlayEofAction: 'pass' })
  assert.match(captureGraph, /fps=60$/)
  assert.match(script, /^\[0:v\]null\[page0\];\[4:v\]format=yuva444p,setpts=PTS-STARTPTS\+0\.5\/TB\[caption0\];/)
  assert.match(script, /\[page0\]\[caption0\]overlay=x=10:y=20:eof_action=pass:format=yuv444:enable='between\(t,0\.5,1\.5\)'\[page1\]/)
  assert.match(script, /\[5:v\][^;]*\+2\/TB\[caption1\];\[page1\]\[caption1\]overlay=x=30:y=40:[^;]*'between\(t,2,3\.25\)'\[video0\]/)
  assert.ok(script.indexOf('[video0]') < script.indexOf('[click0]'))
  assert.match(script, /\[3:a:0\]/)
})

test('shows a caption only while its line is spoken', async () => {
  // These path characters also have meaning in an FFmpeg filter graph.
  const directory = await mkdtemp(join(tmpdir(), "traceframe-caption's [clip],part;-"))
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

test('turns the audio down under the narration just enough to sit 18 dB below the voice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-duck-'))
  try {
    const width = 160, height = 120, fps = 30, rate = 8000
    const rawPath = join(directory, 'capture.mkv'), white = join(directory, 'white.jpg')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${width}x${height}`, '-frames:v', '1', white])
    const capture = createJpegCapture(rawPath, { width, height, fps, onError: assert.fail })
    await capture.append({ data: await readFile(white), timestamp: 1000 })
    await capture.stop(8000)
    // A 440 Hz tone that starts half a second in and steps from quiet to loud to very quiet, under a 1 kHz voice: two
    // lines half a second apart, then a louder line, then the loudest over the very quiet tone.
    const tone = join(directory, 'tone.wav'), narration = join(directory, 'narration.wav')
    const toneLevels = [0.0625, 0.25, 0.02]
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=exprs='sin(2*PI*440*t)*if(lt(t,2.4),${toneLevels[0]},if(lt(t,4.2),${toneLevels[1]},${toneLevels[2]}))':s=48000:d=7`, tone])
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc=exprs='sin(2*PI*1000*t)*(0.125*(between(t,1,1.5)+between(t,2,2.4))+between(t,3.4,4.2)+between(t,5.4,6))':s=48000:d=7", narration])
    const output = join(directory, 'output.mp4')
    await renderVideo({ rawPath, directory, ffmpeg: await probeFfmpeg({ audio: true }),
      trace: { initialPointer: { x: 150, y: 110 }, moves: [], clicks: [], end: 7 },
      config: { video: { width, height, fps }, scale: 1, postRoll: 0, output },
      audio: { path: tone, offset: 0.5 },
      narration: { path: narration, spoken: [{ start: 1, end: 1.5 }, { start: 2, end: 2.4 }, { start: 3.4, end: 4.2 }, { start: 5.4, end: 6 }] },
    })
    // The cut each dip needs, from FFmpeg's own loudness of each input over it.
    const loudnessOver = async (path, from, to) => {
      const { stderr } = await runCommand('ffmpeg', ['-nostats', '-ss', String(from), '-t', String(to - from), '-i', path, '-af', 'aformat=channel_layouts=stereo,ebur128', '-f', 'null', '-'])
      return Number(stderr.match(/I:\s+(-?[\d.]+) LUFS/g).at(-1).match(/-?[\d.]+/)[0])
    }
    const neededCut = async (from, to) => Math.max(0, await loudnessOver(tone, from - 0.5, to - 0.5) - (await loudnessOver(narration, from, to) - 18))
    const cuts = [await neededCut(1, 2.4), await neededCut(3.4, 4.2), await neededCut(5.4, 6)]
    assert.ok(cuts[0] > 8 && cuts[1] > 3 && cuts[0] - cuts[1] > 3, `cuts ${cuts}`)
    assert.equal(cuts[2], 0)

    // Only the tone, read through a narrow band around it.
    const pcm = join(directory, 'output.pcm')
    await runCommand('ffmpeg', ['-v', 'error', '-i', output, '-af', 'bandpass=f=440:width_type=h:width=20,bandpass=f=440:width_type=h:width=20', '-ac', '1', '-ar', String(rate), '-f', 's16le', pcm])
    const samples = new Int16Array((await readFile(pcm)).buffer)
    const level = (from, to) => Math.sqrt(samples.subarray(from * rate, to * rate).reduce((sum, value) => sum + value * value, 0) / ((to - from) * rate))
    const full = level(0.55, 0.75) / toneLevels[0]
    assert.ok(full > 1000, `tone at ${full}`)
    assert.ok(level(0.1, 0.4) < 10)
    const expect = (from, to, toneLevel, cut) => {
      const gain = level(from, to) / (full * toneLevel)
      assert.ok(Math.abs(20 * Math.log10(gain) + cut) < 0.5, `${(20 * Math.log10(gain)).toFixed(2)} dB from ${from} to ${to} s, expected ${-cut.toFixed(2)}`)
    }
    // Down by the first cut through both lines and the short gap between them, back up after, down by the smaller
    // cut for the louder line, and left as it is under the loudest line, where the tone is already quiet enough.
    for (const [from, to] of [[1.05, 1.45], [1.55, 1.95], [2.05, 2.35]]) expect(from, to, toneLevels[0], cuts[0])
    expect(2.95, 3.15, toneLevels[1], 0)
    expect(3.45, 4.15, toneLevels[1], cuts[1])
    expect(4.45, 4.65, toneLevels[1], 0)
    expect(5.45, 5.95, toneLevels[2], 0)
    expect(6.25, 6.5, toneLevels[2], 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('turns the audio down under a short last line and under audio that overlaps the edge of a line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-duck-edges-'))
  try {
    // A 440 Hz tone 6 dB louder than a 1 kHz voice, whose track ends with its last line, as the narration's does.
    const file = async (name, expression, seconds) => {
      const path = join(directory, `${name}.wav`)
      await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=exprs='${expression}':s=48000:d=${seconds}`, path])
      return path
    }
    const cut = async (name, audio, start, end) => {
      const voice = await file(`${name}-voice`, `sin(2*PI*1000*t)*0.125*gte(t,${start})`, end)
      return (await duckUnderVoice(audio, { path: voice, spoken: [{ start, end }] })).map((dip) => dip.cut)
    }
    const [tone, shortTone] = await Promise.all([file('tone', 'sin(2*PI*440*t)*0.25', 3), file('short-tone', 'sin(2*PI*440*t)*0.25', 1.1)])
    const [short, starting, ending, after] = await Promise.all([
      // A 0.3 second last line.
      cut('short', { path: tone, offset: 0 }, 1, 1.3),
      // Audio that starts 50 ms before the last line ends, or ends 50 ms after a line starts, off the 100 ms blocks.
      cut('starting', { path: tone, offset: 2 }, 1, 2.05),
      cut('ending', { path: shortTone, offset: 0 }, 1.05, 2),
      // Audio that starts after the last line.
      cut('after', { path: tone, offset: 2.5 }, 1, 2),
    ])
    for (const cuts of [short, starting, ending]) assert.ok(cuts[0] > 12, `cut ${cuts}`)
    assert.deepEqual(after, [0])
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
      const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range,chroma_location', '-of', 'json', output])
      const { pix_fmt, color_range, chroma_location } = JSON.parse(stdout).streams[0]
      assert.equal(pix_fmt, 'yuv420p')
      assert.equal(color_range, 'tv')
      if (ffmpeg.major === 5 && input === rawPath) assert.equal(chroma_location, 'center', 'keep JPEG chroma siting through lavfi')
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
