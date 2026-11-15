import test from 'node:test'
import assert from 'node:assert/strict'

import { captionY } from '../src/captions.mjs'

const viewport = { width: 1280, height: 800 }
// A caption at the bottom, 32 pixels above the edge.
const caption = { start: 1, end: 3, box: { x: 400, y: 715, width: 480, height: 53 } }
const trace = ({ moves = [], targets = [] } = {}) => ({ initialPointer: { x: 320, y: 720 }, moves, clicks: [], targets })
// The caption's top edge at the bottom (715) or at the top (32).
const position = (caption, trace) => (captionY(caption, trace, viewport) === 715 ? 'bottom' : 'top')
const saveBar = { x: 560, y: 650, width: 160, height: 56 }

test('keeps a caption at the bottom when nothing in use is there', () => {
  assert.equal(position(caption, trace()), 'bottom')
  assert.equal(position(caption, trace({ targets: [{ at: 0, box: { x: 560, y: 80, width: 160, height: 40 } }] })), 'bottom')
})

test('moves a caption to the top when it would cover the element in use', () => {
  assert.equal(position(caption, trace({ targets: [{ at: 2, box: saveBar }] })), 'top')
  // Once the pointer sets off for another element, the first is no longer in use.
  const used = trace({ targets: [{ at: 0, box: saveBar }, { at: 0.5, box: { x: 40, y: 40, width: 80, height: 30 } }] })
  assert.equal(position(caption, used), 'bottom')
  // An element used only after the caption has gone does not count.
  assert.equal(position(caption, trace({ targets: [{ at: 3.5, box: saveBar }] })), 'bottom')
})

test('moves a caption to the top when the pointer moves through it, but not for a resting pointer', () => {
  const across = { at: 1.5, duration: 0.8, from: { x: 100, y: 740 }, to: { x: 1200, y: 740 } }
  assert.equal(position(caption, trace({ moves: [across] })), 'top')
  const done = { at: 0, duration: 0.5, from: { x: 100, y: 100 }, to: { x: 600, y: 740 } }
  assert.equal(position(caption, trace({ moves: [done] })), 'bottom')
})

test('stays at the bottom when the top would cover as much', () => {
  const tall = { x: 0, y: 0, width: 1280, height: 800 }
  assert.equal(position(caption, trace({ targets: [{ at: 0, box: tall }] })), 'bottom')
})

test('an element stops being in use when the pointer moves elsewhere or the page scrolls', () => {
  assert.equal(position(caption, trace({ targets: [{ at: 0, box: saveBar }, { at: 0.5 }] })), 'bottom')
})

test('the flow can fix a caption at either edge', () => {
  assert.equal(captionY({ ...caption, position: 'top' }, trace(), viewport), 32)
  assert.equal(captionY({ ...caption, position: 'bottom' }, trace({ targets: [{ at: 2, box: saveBar }] }), viewport), 715)
})
