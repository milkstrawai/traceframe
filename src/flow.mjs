import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { TraceframeError } from './errors.mjs'

export const LIMITS = {
  maxMoves: 100,
  maxClicks: 100,
  maxActionDuration: 30,
}
const MOVE_SECONDS = 0.5
const DWELL_SECONDS = 0.25
// People hold a mouse button for about 100 ms, long enough for press styles such as :active to show.
const PRESS_HOLD_MS = 100
const MOVE_SAMPLE_MS = 1000 / 30

export async function loadFlow(path, viewport) {
  let module
  try {
    module = await import(pathToFileURL(path).href)
  } catch (error) {
    throw new TraceframeError(`Could not load flow: ${path}: ${error instanceof Error ? error.message : error}`, { code: 'INVALID_FLOW', cause: error })
  }
  if (typeof module.default !== 'function') throw new TraceframeError('Flow must export a default function.', { code: 'INVALID_FLOW' })
  const { x, y } = module.initialPointer ?? { x: Math.round(viewport.width / 4), y: Math.max(0, viewport.height - 80) }
  if (!insideViewport({ x, y }, viewport)) {
    throw new TraceframeError('Flow initialPointer must be a point inside the viewport.', { code: 'INVALID_FLOW' })
  }
  return { run: module.default, ready: module.ready, initialPointer: { x, y } }
}

// Events are timed in seconds from `clock`, the epoch milliseconds of the first video frame.
export function createFlowApi({ page, trace, clock, viewport, signal }) {
  let pointer = trace.initialPointer
  const sleep = (milliseconds) => delay(milliseconds, undefined, { signal })

  const movePointer = async (point, duration) => {
    signal?.throwIfAborted()
    assertBelowLimit(trace.moves, LIMITS.maxMoves, 'move')
    const from = pointer
    const to = { x: point.x, y: point.y }
    trace.moves.push({ at: secondsSince(clock), duration, from, to })

    // Each sample follows the clock, so a late sample skips ahead instead of slowing the move down.
    const total = duration * 1000
    const startedAt = performance.now()
    let elapsed = 0
    while (elapsed < total) {
      await sleep(Math.min(MOVE_SAMPLE_MS, total - elapsed))
      elapsed = Math.min(total, performance.now() - startedAt)
      const eased = easeOutCubic(elapsed / total)
      signal?.throwIfAborted()
      await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased)
    }
    pointer = to
  }

  const moveTo = async (locator, duration, name) => {
    const seconds = durationSeconds(duration ?? MOVE_SECONDS, `${name} duration`)
    const target = await findTarget(locator, signal)
    // A person does not chase a target that shifts under a pointer already on it.
    if (pointInsideBox(pointer, target.box)) return pointer
    let point = await aimPoint(target)
    if (!insideViewport(point, viewport)) {
      const aim = await reveal(target.element, locator, signal)
      if (!aim.visible) throw new TraceframeError(`${locator} could not be revealed by scrolling.`, { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
      point = aim.point
    }
    await movePointer(point, seconds)
    const after = await locator.boundingBox({ signal })
    if (!after || !pointInsideBox(point, after)) {
      throw new TraceframeError(`${locator} moved while the pointer was arriving.`, { code: 'FLOW_TARGET_MOVED' })
    }
    return point
  }

  return {
    async hover(locator, options = {}) {
      await moveTo(locator, options.duration, 'hover')
    },
    async click(locator, options = {}) {
      assertBelowLimit(trace.clicks, LIMITS.maxClicks, 'click')
      const dwell = durationSeconds(options.dwell ?? DWELL_SECONDS, 'click dwell', { allowZero: true })
      const point = await moveTo(locator, options.duration, 'click')
      await sleep(dwell * 1000)
      // Hold on to this element: a control may rename or hide itself once it is pressed.
      const element = await locator.elementHandle({ signal })
      await element.waitForElementState('enabled', { signal }).catch((error) => {
        throw error.name === 'TimeoutError' ? new TraceframeError(`${locator} stayed disabled.`, { code: 'FLOW_TARGET_DISABLED', cause: error }) : error
      })
      await assertReceivesPointer(element, locator, point)
      const at = secondsSince(clock)
      signal?.throwIfAborted()
      await page.mouse.down()
      try {
        await sleep(PRESS_HOLD_MS)
        // A press style such as :active { scale: 0.95 } can shrink the target out from under a pointer near its edge.
        // A target that disappears when pressed, such as an option that closes its list, has already taken the press.
        const pressed = await element.boundingBox()
        if (pressed && !pointInsideBox(point, pressed)) {
          throw new TraceframeError(`${locator} moved away from the pointer when pressed. Click nearer its center.`, { code: 'FLOW_TARGET_MOVED' })
        }
      } finally {
        await page.mouse.up()
      }
      trace.clicks.push({ at, point })
    },
    async move(point, options = {}) {
      if (!insideViewport(point, viewport)) {
        throw new TraceframeError('move requires an { x, y } point inside the viewport.', { code: 'INVALID_FLOW' })
      }
      await movePointer(point, durationSeconds(options.duration ?? MOVE_SECONDS, 'move duration'))
    },
    async scroll(locator) {
      const { shown } = await reveal((await findTarget(locator, signal)).element, locator, signal)
      if (!shown) throw new TraceframeError(`${locator} could not be revealed by scrolling.`, { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
    },
    async wait(seconds) {
      await sleep(durationSeconds(seconds, 'wait', { allowZero: true }) * 1000)
    },
  }
}

function insideViewport(point, viewport) {
  return point?.x >= 0 && point?.y >= 0 && point.x <= viewport.width && point.y <= viewport.height
}

function secondsSince(clock) {
  return (Date.now() - clock) / 1000
}

// render.mjs draws the cursor along the same curve.
function easeOutCubic(progress) {
  return 1 - (1 - progress) ** 3
}

function durationSeconds(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > LIMITS.maxActionDuration) {
    const range = allowZero ? 'between 0 and' : 'more than 0 and at most'
    throw new TraceframeError(`The ${name} must be ${range} ${LIMITS.maxActionDuration} seconds.`, { code: 'INVALID_FLOW' })
  }
  return value
}

function assertBelowLimit(events, limit, type) {
  if (events.length >= limit) {
    throw new TraceframeError(`Flow has more than ${limit} ${type} events.`, { code: 'FLOW_LIMIT' })
  }
}

async function findTarget(locator, signal) {
  await locator.waitFor({ signal })
  const element = await locator.elementHandle({ signal })
  const box = await element.boundingBox()
  if (!box) throw new TraceframeError(`Could not find ${locator}.`, { code: 'FLOW_TARGET_MISSING' })
  return { element, box }
}

function pointInsideBox(point, box) {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
}

// Aim at the middle of the first line box, as Playwright does, so a link that wraps onto two lines is not missed.
async function aimPoint({ element, box }) {
  const offset = await element.evaluate((target) => {
    const bounds = target.getBoundingClientRect()
    const first = target.getClientRects()[0] ?? bounds
    // As fractions of the element's size, because a scaled iframe makes the page box a different size than the element's own.
    return { x: (first.left + first.width / 2 - bounds.left) / bounds.width, y: (first.top + first.height / 2 - bounds.top) / bounds.height }
  })
  return { x: box.x + offset.x * box.width, y: box.y + offset.y * box.height }
}

async function reveal(element, locator, signal) {
  // Content that loads above the target during the scroll can push it out again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await scrollIntoView(element, locator, signal)
    const point = await aimPoint(target)
    const visibility = await target.element.evaluate((node, offset) => new Promise((resolve) => {
      new IntersectionObserver(([entry], observer) => {
        observer.disconnect()
        const bounds = node.getBoundingClientRect()
        const x = bounds.left + offset.x * bounds.width
        const y = bounds.top + offset.y * bounds.height
        const rect = entry.intersectionRect
        const shown = entry.intersectionRatio > 0
        resolve({ shown, visible: shown && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom })
      }).observe(node)
    }), relativePoint(point, target.box))
    if (visibility.visible || attempt === 1) return { point, ...visibility }
    element = target.element
  }
}

// Awaiting the scroll waits for a scrolling panel. Chromium resolves a page scroll before it stops, and a sticky target
// or iframe can stay put while its page scrolls, so also wait for every enclosing page to stop.
async function scrollIntoView(element, locator, signal) {
  signal?.throwIfAborted()
  await element.evaluate((target) => target.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  try {
    await element.waitForElementState('stable', { signal })
    let frame = await element.ownerFrame()
    while (frame) {
      await frame.evaluate(() => new Promise((resolve) => {
        let last
        const check = () => {
          const now = `${scrollX},${scrollY}`
          if (now === last) resolve()
          else requestAnimationFrame(check)
          last = now
        }
        requestAnimationFrame(check)
      }))
      if (!frame.parentFrame()) break
      await (await frame.frameElement()).waitForElementState('stable', { signal })
      frame = frame.parentFrame()
    }
    // The page may replace the target while it scrolls, or remove or hide it, as a menu that closes on scroll does.
    const target = await findTarget(locator, signal).catch((error) => {
      throw error.name === 'TimeoutError' ? new TraceframeError(`${locator} disappeared when it was scrolled into view.`, { code: 'FLOW_TARGET_MISSING', cause: error }) : error
    })
    await target.element.waitForElementState('stable', { signal })
    const box = await target.element.boundingBox()
    if (!box) throw new TraceframeError(`Could not find ${locator}.`, { code: 'FLOW_TARGET_MISSING' })
    return { element: target.element, box }
  } catch (error) {
    throw error.name === 'TimeoutError' ? new TraceframeError(`${locator} kept moving after it was scrolled into view.`, { code: 'FLOW_TARGET_MOVED', cause: error }) : error
  }
}

async function assertReceivesPointer(element, locator, point) {
  const box = await element.boundingBox()
  if (!box || !pointInsideBox(point, box)) {
    throw new TraceframeError(`${locator} moved before the click.`, { code: 'FLOW_TARGET_MOVED' })
  }
  const receivesPointer = await element.evaluate((target, { x, y }) => {
    const rect = target.getBoundingClientRect()
    let current = target.getRootNode().elementFromPoint(rect.left + x * rect.width, rect.top + y * rect.height)
    while (current) {
      if (current === target || target.contains(current)) return true
      current = current.assignedSlot ?? current.parentElement ?? current.getRootNode().host ?? null
    }
    return false
  }, relativePoint(point, box))
  if (!receivesPointer || !(await framesReceivePointer(element, point))) {
    throw new TraceframeError(`${locator} is covered at the click point. If a dialog or toast covers it, wait until it closes; if a panel clips it or a sticky header or bar covers it, call scroll() on the target first.`, { code: 'FLOW_TARGET_OBSCURED' })
  }
}

async function framesReceivePointer(element, point) {
  let frame = await element.ownerFrame()
  while (frame?.parentFrame()) {
    const frameElement = await frame.frameElement()
    const box = await frameElement.boundingBox()
    if (!box) return false
    const hit = await frameElement.evaluate((target, { x, y }) => {
      const rect = target.getBoundingClientRect()
      return target.getRootNode().elementFromPoint(rect.left + x * rect.width, rect.top + y * rect.height) === target
    }, relativePoint(point, box))
    if (!hit) return false
    frame = frame.parentFrame()
  }
  return true
}

function relativePoint(point, box) {
  return { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height }
}
