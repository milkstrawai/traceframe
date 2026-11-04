import test from 'node:test'
import assert from 'node:assert/strict'
import { createCaptureStats } from '../src/capture-stats.mjs'

test('distinguishes capture timestamp gaps from delayed delivery and reordered frames', () => {
  const stats = createCaptureStats()
  stats.observe(1000, 0)
  stats.observe(1020, 20)
  stats.observe(1040, 90)
  stats.observe(1030, 91)
  stats.observe(1080, 100)
  assert.deepEqual(stats.summary(), {
    framesReceived: 5,
    sourceSpanSeconds: 0.08,
    receivedFps: 50,
    maxFrameGapMs: 40,
    maxDeliveryGapMs: 70,
    outOfOrderFrames: 1,
  })
})

test('a single frame on a static page does not imply a sustained frame rate', () => {
  const stats = createCaptureStats()
  assert.equal(stats.summary().receivedFps, 0)
  stats.observe(1000, 0)
  assert.equal(stats.summary().receivedFps, 0)
  assert.equal(stats.summary().framesReceived, 1)
})

test('the timestamp span includes an older frame delivered after the first frame', () => {
  const stats = createCaptureStats()
  stats.observe(1020, 0)
  stats.observe(1000, 1)
  stats.observe(1040, 20)
  assert.equal(stats.summary().sourceSpanSeconds, 0.04)
  assert.equal(stats.summary().receivedFps, 50)
  assert.equal(stats.summary().outOfOrderFrames, 1)
})
