import { createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'

// Keep Chromium's JPEGs and presentation timestamps; encode only during rendering.
// A short reorder window handles JPEGs that finish compression out of order.
const REORDER_MS = 150
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
// Store microseconds. Millisecond rounding can move distinct pictures into the
// same output frame when export resamples to a fixed frame rate.
const TIMESTAMP_SCALE_NS = 1_000

export function createJpegCapture(path, { width, height, fps, onError }) {
  const output = createWriteStream(path)
  let error, origin, newest = -Infinity, last, bufferedBytes = 0, draining, closing
  const pending = []
  const stats = { lateFrames: 0, overflowFrames: 0, maxBufferedBytes: 0, writeWaitMs: 0, maxWriteWaitMs: 0 }
  function fail(cause) {
    if (!error) { error = cause; onError(cause) }
  }
  output.on('error', fail)
  const { bytes, durationOffset } = header(width, height, fps)
  output.write(bytes)

  async function write(frame) {
    if (frame.timestamp < (last?.timestamp ?? origin)) { stats.lateFrames++; return }
    const started = performance.now()
    try {
      await new Promise((resolve, reject) => {
        output.cork()
        output.write(cluster(ticks(frame.timestamp - origin), frame.data.length))
        output.write(frame.data, cause => cause ? reject(cause) : resolve())
        output.uncork()
      })
    } finally {
      const elapsed = performance.now() - started
      stats.writeWaitMs += elapsed
      stats.maxWriteWaitMs = Math.max(stats.maxWriteWaitMs, elapsed)
    }
    last = frame
  }
  async function flush(all = false) {
    while (!error && pending.length && (all || pending[0].timestamp <= newest - REORDER_MS)) {
      const frame = pending.shift()
      try { await write(frame) } finally { bufferedBytes -= frame.data.length }
    }
  }
  return {
    stats,
    append(frame) {
      if (closing || error) return
      origin ??= frame.timestamp
      newest = Math.max(newest, frame.timestamp)
      if (bufferedBytes + frame.data.length > MAX_BUFFER_BYTES) stats.overflowFrames++
      else {
        pending.push(frame)
        pending.sort((a, b) => a.timestamp - b.timestamp)
        bufferedBytes += frame.data.length
      }
      stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, bufferedBytes)
      draining ??= flush().catch(fail).finally(() => { draining = undefined })
      return draining
    },
    stop(stoppedAt = Date.now()) {
      closing ??= (async () => {
        try {
          await draining
          await flush(true)
          if (error) throw error
          // Preserve a static tail without encoding duplicate pictures live.
          if (last && stoppedAt > last.timestamp) await write({ data: last.data, timestamp: stoppedAt })
          output.end()
          await finished(output)
          if (last) {
            const duration = Buffer.from('4489880000000000000000', 'hex')
            duration.writeDoubleBE(ticks(last.timestamp - origin + 1000 / fps), 3)
            const file = await open(path, 'r+')
            try {
              const { bytesWritten } = await file.write(duration, 0, duration.length, durationOffset)
              if (bytesWritten !== duration.length) throw new Error('Could not finish the capture duration.')
            } finally { await file.close() }
          }
        } catch (cause) {
          fail(cause)
          throw cause
        } finally {
          output.destroy()
          await finished(output).catch(() => {})
          pending.length = 0
          last = undefined
          if (origin === undefined && !error) await rm(path, { force: true })
        }
      })()
      return closing
    },
  }
}

// The fixed Matroska subset contains one MJPEG track and one keyframe per cluster.
// Timestamps are microseconds; JPEG dimensions and pixels remain unchanged.
function ticks(milliseconds) {
  return Math.round(milliseconds * 1e6 / TIMESTAMP_SCALE_NS)
}
function uint(value) {
  const bytes = []
  do { bytes.unshift(value % 256); value = Math.floor(value / 256) } while (value)
  return Buffer.from(bytes)
}
function size(value) {
  let length = 1
  while (value >= 2 ** (7 * length) - 1) length++
  const bytes = Buffer.alloc(length)
  for (let i = length - 1; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256) }
  bytes[0] |= 1 << (8 - length)
  return bytes
}
function element(id, value) {
  const data = typeof value === 'number' ? uint(value) : typeof value === 'string' ? Buffer.from(value) : Buffer.concat(value)
  return Buffer.concat([Buffer.from(id, 'hex'), size(data.length), data])
}
function header(width, height, fps) {
  const prefix = Buffer.concat([
    element('1a45dfa3', [element('4286', 1), element('42f7', 1), element('42f2', 4), element('42f3', 8), element('4282', 'matroska'), element('4287', 4), element('4285', 2)]),
    Buffer.from('1853806701ffffffffffffff', 'hex'),
  ])
  // Reserve a Void element, then replace it with Duration after the last write.
  const durationSlot = Buffer.from('ec89000000000000000000', 'hex')
  const info = element('1549a966', [element('2ad7b1', TIMESTAMP_SCALE_NS), element('4d80', 'traceframe'), element('5741', 'traceframe'), durationSlot])
  const bytes = Buffer.concat([prefix, info,
    element('1654ae6b', [element('ae', [element('d7', 1), element('73c5', 1), element('83', 1), element('9c', 0), element('86', 'V_MJPEG'), element('23e383', Math.round(1e9 / fps)), element('e0', [element('b0', width), element('ba', height)])])]),
  ])
  return { bytes, durationOffset: prefix.length + info.length - durationSlot.length }
}
function cluster(timestamp, length) {
  const time = element('e7', timestamp)
  const block = Buffer.concat([Buffer.from('a3', 'hex'), size(length + 4), Buffer.from('81000080', 'hex')])
  return Buffer.concat([Buffer.from('1f43b675', 'hex'), size(time.length + block.length + length), time, block])
}
