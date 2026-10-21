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
  const script = buildFilterScript({ trace, scale: 1 })
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
