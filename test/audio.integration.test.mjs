import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

import { record, recordPage } from '../src/index.mjs'
import { probeFfmpeg, runCommand } from '../src/ffmpeg.mjs'
import { renderVideo } from '../src/render.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const viewport = { width: 320, height: 240 }

let media
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-audio-media-'))
  media = {
    directory,
    path: join(directory, 'stereo tones.wav'),
    rawPath: join(directory, 'capture.webm'),
    late: join(directory, 'late.mkv'),
    shifted: join(directory, 'shifted.webm'),
    live: join(directory, 'live.webm'),
  }
  // Different, separated tones in each channel expose both timing and routing mistakes.
  await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc=exprs='if(between(t,0.25,0.35),0.5*sin(2*PI*880*t),0)|if(between(t,0.6,0.7),0.5*sin(2*PI*440*t),0)':s=44100:d=1", media.path])
  await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=320x240:r=60:d=1', '-c:v', 'libvpx-vp9', media.rawPath])
  await runCommand('ffmpeg', ['-v', 'error', '-i', media.rawPath, '-itsoffset', '0.7', '-i', media.path, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'pcm_s16le', media.late])
  await runCommand('ffmpeg', ['-v', 'error', '-i', media.path, '-c:a', 'libopus', '-avoid_negative_ts', 'disabled', '-output_ts_offset', '-0.5', media.shifted])
  await runCommand('ffmpeg', ['-v', 'error', '-i', media.path, '-c:a', 'libopus', '-live', '1', media.live])
})
after(async () => { if (media) await rm(media.directory, { recursive: true, force: true }) })

async function withMedia(check) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-audio-'))
  try {
    await check({ ...media, directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function inspect(path) {
  await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
  const media = JSON.parse(stdout)
  const audio = media.streams.filter((stream) => stream.codec_type === 'audio')
  assert.equal(audio.length, 1)
  assert.equal(audio[0].codec_name, 'aac')
  assert.equal(audio[0].channels, 2)
  assert.equal(audio[0].sample_rate, '48000')
  const pcm = await exec('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
  return { ...media, samples: pcm.stdout }
}

function rms(samples, channel, start, end) {
  const first = Math.max(0, Math.round(start * 48000))
  const last = Math.min(samples.length / 8, Math.round(end * 48000))
  assert.ok(last > first, `Missing samples at ${start}–${end}`)
  let sum = 0
  for (let index = first; index < last; index++) sum += samples.readFloatLE(index * 8 + channel * 4) ** 2
  return Math.sqrt(sum / (last - first))
}

for (const [offset, end, clicks, fps] of [[0, 1.4, false, 30], [0.375, 1.4, true, 60], [-0.2, 1.4, false, 60], [-0.5, 0.6, true, 30]]) {
  test(`audio offset ${offset}s aligns both channels and preserves a ${end}s video at ${fps} FPS`, { timeout: 30_000 }, async () => {
    await withMedia(async ({ directory, path, rawPath, late }) => {
      const output = join(directory, 'result.mp4')
      const duration = await renderVideo({
        rawPath,
        directory,
        trace: { initialPointer: { x: 10, y: 20 }, moves: [], clicks: clicks ? [{ at: 0.1, point: { x: 100, y: 100 } }] : [], end },
        config: { video: { ...viewport, fps }, scale: 1, postRoll: 0, output },
        ffmpeg: await probeFfmpeg({ audio: true }),
        audio: { path: offset === -0.2 ? late : path, offset },
      })
      const media = await inspect(output)
      assert.ok(Math.abs(duration - end) <= 1.5 / fps)
      assert.ok(Math.abs(media.samples.length / 8 / 48000 - end) < 0.04)
      for (const [channel, at] of [[0, 0.25], [1, 0.6]]) {
        const start = at + offset
        if (start < 0) {
          assert.ok(rms(media.samples, channel, 0, 0.05) < 0.003)
        } else {
          assert.ok(rms(media.samples, channel, start + 0.02, start + 0.08) > 0.25)
          if (start > 0.06) assert.ok(rms(media.samples, channel, start - 0.05, start - 0.02) < 0.003)
          assert.ok(rms(media.samples, 1 - channel, start + 0.02, start + 0.08) < 0.003)
        }
      }
      assert.ok(rms(media.samples, 0, end - 0.08, end - 0.02) < 0.003)
      assert.ok(rms(media.samples, 1, end - 0.08, end - 0.02) < 0.003)
    })
  })
}

test('static audio errors reject before a caller-page flow and preserve the previous output', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path, rawPath }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport })
      const output = join(directory, 'video.mp4')
      await writeFile(output, 'previous output')
      let called = false
      for (const input of [join(directory, 'missing.wav'), directory, rawPath]) {
        await assert.rejects(recordPage({ page, output, audio: { path: input }, flow: () => { called = true } }), { code: 'AUDIO_INVALID' })
      }
      for (const name of ['capture.webm', 'render.filter', 'failure.png']) {
        const input = join(directory, name)
        await copyFile(path, input)
        await assert.rejects(recordPage({ page, output, runDirectory: directory, audio: { path: input }, flow: () => { called = true } }), { code: 'INVALID_CONFIG' })
        assert.deepEqual(await readFile(input), await readFile(path))
      }
      assert.equal(called, false)
      assert.equal(page.isClosed(), false)
      assert.equal(await readFile(output, 'utf8'), 'previous output')
      // Failed preflight leaves neither a page lock nor a running screencast.
      const result = await recordPage({ page, output, audio: { path }, flow: async ({ wait }) => wait(0.8) })
      assert.equal(result.audio, true)
      await inspect(output)
    } finally {
      await browser.close()
    }
  })
})

test('negative audio offsets use samples rather than container duration and can trim all audio', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path, shifted, live }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport })
      for (const [index, [input, offset]] of [[shifted, -0.6], [path, -2], [live, -2]].entries()) {
        const result = await recordPage({ page, output: join(directory, `${index}.mp4`), postRoll: 0, audio: { path: input, offset }, flow: async ({ wait }) => wait(0.3) })
        assert.equal(result.audio, true)
        const { samples } = await inspect(result.output)
        if (offset === -0.6) {
          assert.ok(rms(samples, 1, 0.02, 0.08) > 0.25)
          assert.ok(rms(samples, 0, 0.02, 0.08) < 0.003)
        } else {
          assert.ok(samples.every((byte) => byte === 0))
        }
      }
    } finally {
      await browser.close()
    }
  })
})

test('an audio supplier cannot overwrite its input through the retained filter file', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport })
      const output = join(directory, 'video.mp4')
      const input = join(directory, 'render.filter')
      await writeFile(output, 'previous output')
      await assert.rejects(recordPage({
        page, output, runDirectory: directory, postRoll: 0, flow: async ({ wait }) => wait(0.1),
        audio: async () => { await copyFile(path, input); return { path: input } },
      }), { code: 'INVALID_CONFIG' })
      assert.deepEqual(await readFile(input), await readFile(path))
      assert.equal(await readFile(output, 'utf8'), 'previous output')
      assert.equal(page.isClosed(), false)
    } finally {
      await browser.close()
    }
  })
})

test('an audio supplier uses the first-frame clock, runs after capture, and preserves caller ownership', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport })
      await page.setContent('<button onclick="this.textContent=\'Done\'">Save</button>')
      let eventAt
      let completed = false
      let supplied = false
      const requestedAt = Date.now()
      const result = await recordPage({
        page, output: join(directory, 'video.mp4'), postRoll: 0,
        flow: async ({ click, wait }) => {
          eventAt = Date.now()
          await click(page.getByRole('button'), { duration: 0.05, dwell: 0 })
          await wait(0.8)
          completed = true
        },
        audio: async ({ startedAt, signal }) => {
          assert.equal(completed, true)
          assert.equal(signal, undefined)
          assert.ok(startedAt >= requestedAt && startedAt <= eventAt)
          const generated = join(directory, 'recorded.wav')
          await writeFile(generated, await readFile(path))
          supplied = true
          return { path: generated, offset: (eventAt - startedAt) / 1000 }
        },
      })
      assert.equal(supplied, true)
      assert.equal(result.audio, true)
      assert.equal(page.isClosed(), false)
      assert.equal(await page.getByRole('button').textContent(), 'Done')
      await inspect(result.output)
    } finally {
      await browser.close()
    }
  })
})

test('managed record and CLI both add audio, including a negative CLI offset', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const flow = join(directory, 'flow.mjs')
    await writeFile(flow, 'export default async ({ wait }) => { await wait(0.8) }')
    const options = { url: 'data:text/html,<h1>Audio demo</h1>', flow, preset: 'draft', viewportWidth: 320, viewportHeight: 240, postRoll: 0 }
    const summary = await record({ ...options, output: join(directory, 'api.mp4'), audio: { path } })
    assert.equal(summary.audio, true)
    await inspect(summary.output)
    const { stdout, stderr } = await exec(process.execPath, [cli, 'record', '--url', options.url, '--flow', flow, '--preset', 'draft', '--viewport-width', '320', '--viewport-height', '240', '--post-roll', '0', '--audio', path, '--audio-offset=-0.2', '--out', join(directory, 'cli.mp4')])
    assert.equal(stderr, '')
    const cliSummary = JSON.parse(stdout)
    assert.equal(cliSummary.audio, true)
    const media = await inspect(cliSummary.output)
    assert.ok(rms(media.samples, 0, 0.07, 0.13) > 0.25)
  })
})

test('audio outside the video and a failed audio supplier preserve output and retain the capture', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const flow = join(directory, 'flow.mjs')
    await writeFile(flow, 'export default async ({ wait }) => { await wait(0.1) }')
    const output = join(directory, 'video.mp4')
    await writeFile(output, 'previous output')
    const cases = [
      [{ path, offset: 10 }, { code: 'AUDIO_OUTSIDE_VIDEO' }],
      [() => undefined, { code: 'INVALID_CONFIG' }],
      [() => { throw new Error('recorder failed') }, { message: 'recorder failed' }],
    ]
    for (const [index, [audio, expected]] of cases.entries()) {
      const runDirectory = join(directory, `run-${index}`)
      await assert.rejects(record({ url: 'data:text/html,<p>Demo</p>', flow, output, preset: 'draft', viewportWidth: 320, viewportHeight: 240, postRoll: 0, runDirectory, audio }), (error) => {
        for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value)
        assert.equal(error.diagnostics.capturePath, join(runDirectory, 'capture.webm'))
        return true
      })
      assert.equal(await readFile(output, 'utf8'), 'previous output')
      assert.ok((await readdir(runDirectory)).includes('capture.webm'))
    }
  })
})

test('flow failure skips audio collection, and cooperative audio cancellation leaves the page reusable', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport })
      const output = join(directory, 'video.mp4')
      let collected = false
      await assert.rejects(recordPage({ page, output, flow: () => { throw new Error('flow failed') }, audio: () => { collected = true; return { path } } }), /flow failed/)
      assert.equal(collected, false)
      const controller = new AbortController()
      const reason = new Error('cancel audio collection')
      await assert.rejects(recordPage({
        page, output, signal: controller.signal, postRoll: 0,
        flow: async ({ wait }) => wait(0.1),
        audio: async ({ signal }) => {
          assert.equal(signal, controller.signal)
          controller.abort(reason)
          await delay(1000, undefined, { signal })
          return { path }
        },
      }), (error) => error === reason)
      assert.equal(page.isClosed(), false)
      assert.equal((await readdir(directory)).some((file) => file.endsWith('.tmp.mp4') || file === 'video.mp4'), false)
      await recordPage({ page, output, flow: async ({ wait }) => wait(0.1) })
    } finally {
      await browser.close()
    }
  })
})

test('aborting an audio render removes its temporary output and preserves the previous file', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path }) => {
    const browser = await chromium.launch()
    const controller = new AbortController()
    const reason = new Error('cancel audio render')
    let watcher
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const output = join(directory, 'video.mp4')
      await writeFile(output, 'previous output')
      watcher = setInterval(async () => {
        if ((await readdir(directory)).some((name) => name.endsWith('.tmp.mp4'))) controller.abort(reason)
      }, 10)
      await assert.rejects(recordPage({ page, output, fps: 60, audio: { path }, signal: controller.signal, flow: async ({ wait }) => wait(2) }), (error) => error === reason)
      assert.equal(await readFile(output, 'utf8'), 'previous output')
      assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp.mp4')), false)
      assert.equal(page.isClosed(), false)
    } finally {
      clearInterval(watcher)
      await browser.close()
    }
  })
})

test('padded audio cannot hide a truncated video or replace the previous output', { timeout: 30_000 }, async () => {
  await withMedia(async ({ directory, path, rawPath }) => {
    const output = join(directory, 'video.mp4')
    await writeFile(output, 'previous output')
    await assert.rejects(renderVideo({
      rawPath, directory,
      trace: { initialPointer: { x: 10, y: 20 }, moves: [], clicks: [], end: 3 },
      config: { video: { ...viewport, fps: 30 }, scale: 1, postRoll: 0, output },
      ffmpeg: await probeFfmpeg({ audio: true }),
      audio: { path, offset: 0 },
    }), { code: 'OUTPUT_MISMATCH' })
    assert.equal(await readFile(output, 'utf8'), 'previous output')
    assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp.mp4')), false)
  })
})
