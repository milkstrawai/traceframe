import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { createFlow, createFlowApi, createTrace } from '../src/flow.mjs'

const box = { x: 100, y: 100, width: 80, height: 40 }

function setup() {
  const page = {
    mouse: {
      moves: [],
      async move(x, y) { this.moves.push({ x, y }) },
      async down() { this.downAt = performance.now() },
      async up() { this.upAt = performance.now() },
    },
  }
  const trace = createTrace({ x: 20, y: 20 })
  const api = createFlowApi({ page, trace, clock: Date.now(), viewport: { width: 400, height: 300 } })
  return { page, trace, api }
}

// A target whose box depends on the phase: before the pointer moves, after it arrives, just before the click, and while pressed.
function target(page, { start = box, arrived = start, beforeClick = arrived, pressed = beforeClick, enabledError, enabling, receivesPointer = true } = {}) {
  const element = {
    async dispose() {},
    async boundingBox() { return page.mouse.downAt !== undefined ? pressed : page.mouse.moves.length ? beforeClick : start },
    async waitForElementState() {
      if (enabledError) throw enabledError
      await enabling
    },
    // The hit test passes the point to check; aiming passes nothing.
    async evaluate(_, point) { return point ? receivesPointer : { x: 0.5, y: 0.5 } },
    async ownerFrame() { return { parentFrame: () => null } },
  }
  return {
    async waitFor() {},
    async boundingBox() { return page.mouse.moves.length ? arrived : start },
    async elementHandle() { return element },
  }
}

test('eases the pointer to the target center and sends the end point once', async () => {
  const { api, page } = setup()
  await api.hover(target(page), { duration: 0.2 })
  const xs = page.mouse.moves.map((move) => move.x)
  assert.deepEqual(page.mouse.moves.at(-1), { x: 140, y: 120 })
  assert.equal(xs.filter((x) => x === 140).length, 1)
  assert.ok(xs.every((x, index) => index === 0 || x > xs[index - 1]))
})

test('allows a target to resize under a hover style when the point remains inside it', async () => {
  const { api, page } = setup()
  await assert.doesNotReject(api.hover(target(page, { arrived: { x: 96, y: 98, width: 88, height: 44 } }), { duration: 0.01 }))
})

test('clicks where the pointer is when a hover effect shifts the target under it', async () => {
  const { api, page, trace } = setup()
  const shifting = target(page, { arrived: { x: 100, y: 98, width: 80, height: 40 } })
  await api.hover(shifting, { duration: 0.01 })
  const moveCount = page.mouse.moves.length
  await api.click(shifting, { dwell: 0 })
  assert.equal(page.mouse.moves.length, moveCount)
  assert.deepEqual(trace.clicks.at(-1).point, trace.moves.at(-1).to)
})

test('refuses a target that moves away while the pointer arrives', async () => {
  const { api, page } = setup()
  await assert.rejects(api.hover(target(page, { arrived: { ...box, x: 300 } }), { duration: 0.01 }), { code: 'FLOW_TARGET_MOVED' })
})

test('refuses a target that disappears while the pointer arrives', async () => {
  const { api, page } = setup()
  await assert.rejects(api.hover(target(page, { arrived: null }), { duration: 0.01 }), { code: 'FLOW_TARGET_MOVED' })
})

test('refuses a target that moves away before the click', async () => {
  const { api, page } = setup()
  await assert.rejects(api.click(target(page, { beforeClick: { ...box, x: 300 } }), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_MOVED' })
  assert.equal(page.mouse.downAt, undefined)
})

test('refuses a target that slips from under the pointer when pressed, and releases the button', async () => {
  const { api, page, trace } = setup()
  await assert.rejects(api.click(target(page, { pressed: { x: 150, y: 100, width: 30, height: 40 } }), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_MOVED' })
  assert.ok(page.mouse.upAt)
  assert.equal(trace.clicks.length, 0)
})

test('refuses disabled and covered click targets', async () => {
  const disabled = setup()
  const timeout = Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' })
  await assert.rejects(disabled.api.click(target(disabled.page, { enabledError: timeout }), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_DISABLED' })
  const covered = setup()
  await assert.rejects(covered.api.click(target(covered.page, { receivesPointer: false }), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
})

test('reports why a target could not be checked for enabled, other than a timeout', async () => {
  const { api, page } = setup()
  const detached = new Error('Element is not attached to the DOM')
  await assert.rejects(api.click(target(page, { enabledError: detached }), { duration: 0.01, dwell: 0 }), (error) => error === detached)
})

test('stops at the move limit', async () => {
  const { api, trace } = setup()
  trace.moves.push(...Array(100).fill({}))
  await assert.rejects(api.move({ x: 50, y: 50 }, { duration: 0.01 }), { code: 'FLOW_LIMIT' })
})

test('stops at the click limit', async () => {
  const { api, page, trace } = setup()
  trace.clicks.push(...Array(100).fill({}))
  await assert.rejects(api.click(target(page)), { code: 'FLOW_LIMIT' })
})

test('holds the mouse button down briefly like a person', async () => {
  const { api, page } = setup()
  await api.click(target(page), { duration: 0.01, dwell: 0 })
  assert.ok(page.mouse.upAt - page.mouse.downAt >= 90)
})

test('requires a wait duration', async () => {
  const { api } = setup()
  await assert.rejects(api.wait(), { code: 'INVALID_FLOW', message: /wait must be between 0 and 30 seconds/ })
})

test('records each element the pointer sets off for, where it ends up', async () => {
  const { api, page, trace } = setup()
  const arrived = { x: 96, y: 98, width: 88, height: 44 }
  await api.hover(target(page, { arrived }), { duration: 0.01 })
  await api.click(target(page, { start: arrived }), { duration: 0.01, dwell: 0 })
  assert.deepEqual(trace.targets.map((target) => target.box), [arrived, arrived])
  assert.ok(trace.targets[0].at <= trace.moves[0].at && trace.targets[1].at >= trace.targets[0].at)
  // Moving the pointer elsewhere ends the last element's use.
  await api.move({ x: 300, y: 250 }, { duration: 0.01 })
  assert.deepEqual(Object.keys(trace.targets.at(-1)), ['at'])
})

test('the click that say() uses presses only once its line is ready, and returns the press time', async () => {
  const page = setup().page
  const trace = createTrace({ x: 20, y: 20 })
  let click
  createFlowApi({ page, trace, clock: Date.now(), viewport: { width: 400, height: 300 }, narration: { narrator: (helpers) => { click = helpers.click } } })
  const order = []
  const at = await click(target(page), { duration: 0.01, dwell: 0 }, {
    async beforePress() {
      await delay(50)
      order.push(page.mouse.downAt === undefined ? 'ready' : 'late')
    },
  })
  assert.deepEqual(order, ['ready'])
  assert.equal(at, trace.clicks[0].at)

  // A line that fails while its target is still being checked stops the press.
  const line = new AbortController()
  const failure = new Error('during failed')
  const enabling = delay(50).then(() => line.abort(failure))
  await assert.rejects(click(target(page, { enabling }), { duration: 0.01, dwell: 0 }, { signal: line.signal }), (error) => error === failure)
  assert.equal(trace.clicks.length, 1)
})

test('say() asks for voice when the flow does not turn it on', async () => {
  const { api } = setup()
  await assert.rejects(api.say('Hello.'), { code: 'INVALID_FLOW', message: /needs voice/ })
})

test('voice is off, on with captions, or on without them', () => {
  const viewport = { width: 400, height: 300 }
  const voiceOf = (voice) => createFlow(() => {}, viewport, undefined, voice).voice
  assert.equal(voiceOf(undefined), undefined)
  assert.equal(voiceOf(false), undefined)
  assert.deepEqual(voiceOf(true), { captions: true })
  assert.deepEqual(voiceOf({ captions: false }), { captions: false })
  for (const voice of ['yes', null, {}, { captions: 'no' }]) assert.throws(() => voiceOf(voice), { code: 'INVALID_FLOW' })
})
