import test from 'node:test'
import assert from 'node:assert/strict'

import { createFlowApi } from '../src/flow.mjs'

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
  const trace = { initialPointer: { x: 20, y: 20 }, moves: [], clicks: [] }
  const api = createFlowApi({ page, trace, clock: Date.now(), viewport: { width: 400, height: 300 } })
  return { page, trace, api }
}

// A target whose box depends on the phase: before the pointer moves, after it arrives, just before the click, and while pressed.
function target(page, { start = box, arrived = start, beforeClick = arrived, pressed = beforeClick, enabledError, receivesPointer = true } = {}) {
  const element = {
    async boundingBox() { return page.mouse.downAt === undefined ? beforeClick : pressed },
    async waitForElementState() { if (enabledError) throw enabledError },
    async evaluate() { return receivesPointer },
    async ownerFrame() { return { parentFrame: () => null } },
  }
  return {
    async waitFor() {},
    async boundingBox() { return page.mouse.moves.length ? arrived : start },
    async evaluate() { return { x: 0.5, y: 0.5 } },
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
