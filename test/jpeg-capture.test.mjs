import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJpegCapture } from '../src/jpeg-capture.mjs'
import { runCommand } from '../src/ffmpeg.mjs'

async function fixture(check) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-jpeg-'))
  try {
    const image = join(directory, 'frame.jpg')
    await runCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x24', '-frames:v', '1', image])
    await check({ directory, data: await readFile(image), path: join(directory, 'capture.mkv') })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('JPEG capture preserves source timestamps, sorts delayed frames, and retains a static tail', async () => {
  await fixture(async ({ data, path }) => {
    const capture = createJpegCapture(path, { width: 32, height: 24, fps: 60, onError: assert.fail })
    for (const timestamp of [1000, 1080, 1040]) await capture.append({ data, timestamp })
    await capture.stop(1300)
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_packets', '-show_streams', '-show_entries', 'packet=pts_time:stream=codec_name,width,height', '-of', 'json', path])
    const probe = JSON.parse(stdout)
    assert.deepEqual(probe.packets.map(packet => Number(packet.pts_time)), [0, 0.04, 0.08, 0.3])
    assert.deepEqual(probe.streams.map(({ codec_name, width, height }) => ({ codec_name, width, height })), [{ codec_name: 'mjpeg', width: 32, height: 24 }])
    await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
    assert.equal(capture.stats.lateFrames, 0)
  })
})

test('frames arriving beyond the reorder window cannot move the recording backwards', async () => {
  await fixture(async ({ data, path }) => {
    const capture = createJpegCapture(path, { width: 32, height: 24, fps: 30, onError: assert.fail })
    for (const timestamp of [1000, 1200, 1500, 1100, 980]) await capture.append({ data, timestamp })
    await capture.stop(1600)
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=pts_time', '-of', 'json', path])
    assert.deepEqual(JSON.parse(stdout).packets.map(packet => Number(packet.pts_time)), [0, 0.2, 0.5, 0.6])
    assert.equal(capture.stats.lateFrames, 2)
  })
})

test('a full reorder buffer stays bounded and resumes after time advances', async () => {
  await fixture(async ({ data, path }) => {
    const capture = createJpegCapture(path, { width: 32, height: 24, fps: 60, onError: assert.fail })
    // Exercise the actual cap without exposing a production tuning/test option.
    await capture.append({ data: Buffer.alloc(64 * 1024 * 1024), timestamp: 1000 })
    await capture.append({ data, timestamp: 1001 })
    await capture.append({ data, timestamp: 1400 })
    await capture.append({ data, timestamp: 1600 })
    await capture.stop(1700)
    assert.equal(capture.stats.maxBufferedBytes, 64 * 1024 * 1024)
    assert.equal(capture.stats.overflowFrames, 2)
    const bytes = await readFile(path)
    assert.ok(bytes.subarray(-data.length).equals(data), 'capture must recover and write the last valid frame')
  })
})

test('disk failures reach the owner and an empty capture does not leave a misleading artifact', async () => {
  await fixture(async ({ directory, path }) => {
    const failed = Promise.withResolvers()
    const capture = createJpegCapture(directory, { width: 32, height: 24, fps: 60, onError: failed.resolve })
    const error = await failed.promise
    assert.ok(['EISDIR', 'EACCES', 'EPERM'].includes(error.code), error.code)
    await assert.rejects(capture.stop(), reason => reason === error)
    const empty = createJpegCapture(path, { width: 32, height: 24, fps: 60, onError: assert.fail })
    await empty.stop()
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })
})

test('timestamp ties stay ordered, sub-millisecond times are kept, and a startup frame before the origin is dropped', async () => {
  await fixture(async ({ data, path }) => {
    const capture = createJpegCapture(path, { width: 32, height: 24, fps: 60, onError: assert.fail })
    for (const timestamp of [1000, 1000, 1000.2, 1000.4, 999, 1020]) await capture.append({ data, timestamp })
    await capture.stop(1030)
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=pts_time', '-of', 'json', path])
    assert.deepEqual(JSON.parse(stdout).packets.map(packet => Number(packet.pts_time)), [0, 0, 0.0002, 0.0004, 0.02, 0.03])
    assert.equal(capture.stats.lateFrames, 1)
    await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-fps_mode', 'passthrough', '-f', 'null', '-'])
  })
})

for (const fail of [false, true]) {
  test(`in-flight writes ${fail ? 'propagate a disk-full error once' : 'hold frame acknowledgment and finalization until accepted'}`, { timeout: 10_000 }, async (t) => {
    await fixture(async ({ data, path }) => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), failed = []
      const create = fs.createWriteStream
      let stream
      const mock = t.mock.method(fs, 'createWriteStream', (...args) => {
        stream = create(...args)
        const writev = stream._writev
        stream._writev = function (chunks, callback) {
          entered.resolve()
          release.promise.then(() => {
            if (fail) callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
            else writev.call(this, chunks, callback)
          })
        }
        return stream
      })
      syncBuiltinESMExports()
      let capture
      try {
        capture = createJpegCapture(path, { width: 32, height: 24, fps: 60, onError: error => failed.push(error) })
        await capture.append({ data, timestamp: 1000 })
        let acknowledged = false, stopped = false
        const pending = capture.append({ data, timestamp: 1200 }).then(() => { acknowledged = true })
        await entered.promise
        const stop = capture.stop(1300).then(() => { stopped = true })
        // Register rejection handling before releasing the failing callback.
        const outcome = fail ? assert.rejects(stop, error => error.code === 'ENOSPC') : stop
        await delay(25)
        assert.equal(acknowledged, false)
        assert.equal(stopped, false)
        release.resolve()
        await pending
        await outcome
        assert.ok(capture.stats.maxWriteWaitMs >= 20)
        assert.ok(capture.stats.writeWaitMs >= capture.stats.maxWriteWaitMs)
        assert.equal(stream.destroyed, true)
        assert.equal(failed.length, fail ? 1 : 0)
        if (!fail) await runCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
      } finally {
        release.resolve()
        await capture?.stop().catch(() => {})
        mock.mock.restore()
        syncBuiltinESMExports()
      }
    })
  })
}
