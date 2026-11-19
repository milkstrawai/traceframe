import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { easePoint } from './easing.mjs'
import { TraceframeError } from './errors.mjs'

export const LIMITS = {
  maxMoves: 100,
  maxClicks: 100,
  maxActionDuration: 30,
}
export const MOVE_SECONDS = 0.5
export const DWELL_SECONDS = 0.25
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
  return { ...createFlow(module.default, viewport, module.initialPointer, module.voice), ready: module.ready }
}

export function createFlow(run, viewport, initialPointer, voice) {
  if (typeof run !== 'function') throw new TraceframeError('Flow must be a function.', { code: 'INVALID_FLOW' })
  const { x, y } = initialPointer ?? { x: Math.round(viewport.width / 4), y: Math.max(0, viewport.height - 80) }
  if (!insideViewport({ x, y }, viewport)) {
    throw new TraceframeError('Flow initialPointer must be a point inside the viewport.', { code: 'INVALID_FLOW' })
  }
  return { run, initialPointer: { x, y }, voice: voiceSettings(voice) }
}

function voiceSettings(voice) {
  if (voice === undefined || voice === false) return undefined
  if (voice === true) return { captions: true }
  if (typeof voice?.captions === 'boolean') return { captions: voice.captions }
  throw new TraceframeError('Flow voice must be true, false or { captions: true | false }.', { code: 'INVALID_FLOW' })
}

// The pointer timeline that render.mjs draws. Flow helpers add moves ({ at, duration, from, to }) and clicks
// ({ at, point }), and the capture sets `end` when the flow returns. Times are seconds from `clock`, the epoch
// milliseconds of the first video frame. Targets ({ at, box }) are the elements the pointer sets off for, which
// captions keep clear of; one without a box, from move() or scroll(), ends the one before.
export function createTrace(initialPointer) {
  return { initialPointer, moves: [], clicks: [], targets: [], marks: [] }
}

export function secondsSince(clock) {
  return (Date.now() - clock) / 1000
}

// With `narration` (narration.mjs), the helpers include say().
export function createFlowApi({ page, trace, clock, viewport, signal, narration }) {
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
      const { x, y } = easePoint(from, to, elapsed / total)
      signal?.throwIfAborted()
      await page.mouse.move(x, y)
    }
    pointer = to
  }

  const moveTo = async (locator, duration, name, handles) => {
    const seconds = durationSeconds(duration ?? MOVE_SECONDS, `${name} duration`)
    const target = await findTarget(locator, signal, handles)
    const at = secondsSince(clock)
    // A person does not chase a target that shifts under a pointer already on it.
    if (pointInsideBox(pointer, target.box)) {
      trace.targets.push({ at, box: target.box })
      return pointer
    }
    let point = await aimPoint(target)
    if (!insideViewport(point, viewport)) {
      const aim = await reveal(target.element, locator, signal, handles)
      if (!aim.visible) throw new TraceframeError(`${locator} could not be revealed by scrolling.`, { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
      point = aim.point
    }
    await movePointer(point, seconds)
    const after = await locator.boundingBox({ signal })
    if (!after || !pointInsideBox(point, after)) {
      throw new TraceframeError(`${locator} moved while the pointer was arriving.`, { code: 'FLOW_TARGET_MOVED' })
    }
    trace.targets.push({ at, box: after })
    return point
  }

  // click(), which say() also uses with `line`: it waits for `line.beforePress` after the dwell, does not press once
  // `line.signal` aborts, and returns when it pressed.
  const press = withHandles(async (handles, locator, options = {}, line = {}) => {
    assertBelowLimit(trace.clicks, LIMITS.maxClicks, 'click')
    const dwell = durationSeconds(options.dwell ?? DWELL_SECONDS, 'click dwell', { allowZero: true })
    const point = await moveTo(locator, options.duration, 'click', handles)
    await sleep(dwell * 1000)
    await line.beforePress?.()
    // Hold on to this element: a control may rename or hide itself once it is pressed.
    const element = await locator.elementHandle({ signal })
    handles.push(element)
    await element.waitForElementState('enabled', { signal }).catch((error) => {
      throw fromTimeout(error, `${locator} stayed disabled.`, 'FLOW_TARGET_DISABLED')
    })
    await assertReceivesPointer(element, locator, point, handles)
    const at = secondsSince(clock)
    signal?.throwIfAborted()
    line.signal?.throwIfAborted()
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
    return at
  })

  return {
    hover: withHandles(async (handles, locator, options = {}) => {
      await moveTo(locator, options.duration, 'hover', handles)
    }),
    async click(locator, options) {
      await press(locator, options)
    },
    async move(point, options = {}) {
      if (!insideViewport(point, viewport)) {
        throw new TraceframeError('move requires an { x, y } point inside the viewport.', { code: 'INVALID_FLOW' })
      }
      trace.targets.push({ at: secondsSince(clock) })
      await movePointer(point, durationSeconds(options.duration ?? MOVE_SECONDS, 'move duration'))
    },
    scroll: withHandles(async (handles, locator, { block = 'center' } = {}) => {
      if (!['start', 'center', 'end'].includes(block)) throw new TraceframeError('scroll() block must be start, center or end.', { code: 'INVALID_FLOW' })
      trace.targets.push({ at: secondsSince(clock) })
      const { shown } = await reveal((await findTarget(locator, signal, handles)).element, locator, signal, handles, block)
      if (!shown) throw new TraceframeError(`${locator} could not be revealed by scrolling.`, { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
    }),
    mark(name) {
      // A listener on a caller-owned page can outlive the flow, even after a failed take.
      if (trace.end !== undefined || signal?.aborted) return
      if (typeof name !== 'string' || !name.trim()) throw new TraceframeError('mark() needs a non-empty name.', { code: 'INVALID_FLOW' })
      trace.marks.push({ name, at: Math.max(0, secondsSince(clock)) })
    },
    async wait(seconds) {
      await sleep(durationSeconds(seconds, 'wait', { allowZero: true }) * 1000)
    },
    say: narration?.narrator({ clock, signal, click: press }) ?? (async () => {
      throw new TraceframeError('say() needs voice: export voice = true from the flow file, or pass voice: true to recordPage.', { code: 'INVALID_FLOW' })
    }),
  }
}

// A helper may outlive a cancelled recording; release its handles when that helper actually settles.
function withHandles(run) {
  return async (...args) => {
    const handles = []
    try {
      return await run(handles, ...args)
    } finally {
      await Promise.all(handles.map(handle => handle.dispose().catch(() => {})))
    }
  }
}

function insideViewport(point, viewport) {
  return point?.x >= 0 && point?.y >= 0 && point.x <= viewport.width && point.y <= viewport.height
}

function durationSeconds(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > LIMITS.maxActionDuration) {
    const range = allowZero ? 'between 0 and' : 'more than 0 and at most'
    throw new TraceframeError(`The ${name} must be ${range} ${LIMITS.maxActionDuration} seconds.`, { code: 'INVALID_FLOW' })
  }
  return value
}

// Playwright reports a wait that ran out of time as a TimeoutError; name what the flow was waiting for instead.
function fromTimeout(error, message, code) {
  return error?.name === 'TimeoutError' ? new TraceframeError(message, { code, cause: error }) : error
}

function assertBelowLimit(events, limit, type) {
  if (events.length >= limit) {
    throw new TraceframeError(`Flow has more than ${limit} ${type} events.`, { code: 'FLOW_LIMIT' })
  }
}

async function findTarget(locator, signal, handles, afterScroll = false) {
  for (let attempt = 0; ; attempt++) {
    await locator.waitFor({ signal })
    const element = await locator.elementHandle({ signal })
    handles.push(element)
    try {
      if (afterScroll) await element.waitForElementState('stable', { signal }).catch((error) => {
        throw fromTimeout(error, `${locator} kept moving after it was scrolled into view.`, 'FLOW_TARGET_MOVED')
      })
      const box = await element.boundingBox()
      if (!box) throw new TraceframeError(`Could not find ${locator}.`, { code: 'FLOW_TARGET_MISSING' })
      return { element, box }
    } catch (error) {
      // The page can replace a visible node between resolving it and reading its stable box.
      signal?.throwIfAborted()
      if (attempt === 1 || await element.evaluate(node => node.isConnected).catch(() => true)) throw error
    }
  }
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

async function reveal(element, locator, signal, handles, block) {
  if (block === undefined) {
    // Content loading above a pointer target can push its aim point out of view again.
    const first = await scrollAndObserve(element, locator, signal, handles, 'center')
    return first.visible ? first : scrollAndObserve(first.element, locator, signal, handles, 'center')
  }

  let target = await scrollIntoView(element, locator, signal, handles, block)
  let replaced = false
  for (let attempt = 1; ; attempt++) {
    const result = await scrollAndObserve(target.element, locator, signal, handles, block)
    const alignment = await correctAlignment(locator, target.element, result, block, signal)
    if (alignment === 'aligned') return result
    signal?.throwIfAborted()
    if (attempt === 3 || (alignment === 'replaced' && replaced)) break
    if (alignment === 'replaced') {
      replaced = true
      const next = await findScrolledTarget(locator, signal, handles)
      target = await scrollIntoView(next.element, locator, signal, handles, block)
    } else {
      target = result
    }
  }
  throw new TraceframeError(`${locator} kept changing while it was scrolled into view.`, { code: 'FLOW_TARGET_MOVED' })
}

async function scrollAndObserve(element, locator, signal, handles, block) {
  const target = await scrollIntoView(element, locator, signal, handles, block)
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
  return { ...target, point, ...visibility }
}

// After the smooth scroll settles, ask Chromium to apply the alignment against the current margins and scrollports.
// A late correction can fire scrollend and change the layout again, so check visibility again if the target moved.
async function correctAlignment(locator, scrolled, { element, frameElements }, block, signal) {
  const framePositions = () => Promise.all(frameElements.map(handle => handle.evaluate(node => {
    const { x, y } = node.getBoundingClientRect()
    return `${x},${y}`
  })))
  const before = await framePositions()
  signal?.throwIfAborted()
  const state = await locator.evaluateAll(async (matches, [scrolled, node, block]) => {
    if (matches.length !== 1 || matches[0] !== node || node !== scrolled || !node.isConnected) return 'replaced'
    const start = node.getBoundingClientRect()
    const scrolling = node.scrollIntoView({ behavior: 'instant', block })
    const end = node.getBoundingClientRect()
    await scrolling
    return start.x === end.x && start.y === end.y ? 'aligned' : 'moved'
  }, [scrolled, element, block])
  if (state !== 'aligned') return state
  const after = await framePositions()
  return before.some((position, i) => position !== after[i]) ? 'moved' : 'aligned'
}

// Awaiting the scroll waits for a scrolling panel. Chromium resolves a page scroll before it stops, and a sticky target
// or iframe can stay put while its page scrolls, so also wait for every enclosing page to stop.
async function scrollIntoView(element, locator, signal, handles, block) {
  signal?.throwIfAborted()
  await element.evaluate((target, block) => target.scrollIntoView({ behavior: 'smooth', block }), block)
  try {
    const frameElements = []
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
      const frameElement = await frame.frameElement()
      handles.push(frameElement)
      frameElements.push(frameElement)
      await frameElement.waitForElementState('stable', { signal })
      frame = frame.parentFrame()
    }
    // The page may replace the target while it scrolls, or remove or hide it, as a menu that closes on scroll does.
    return { ...await findScrolledTarget(locator, signal, handles), frameElements }
  } catch (error) {
    throw fromTimeout(error, `${locator} kept moving after it was scrolled into view.`, 'FLOW_TARGET_MOVED')
  }
}

function findScrolledTarget(locator, signal, handles) {
  return findTarget(locator, signal, handles, true).catch((error) => {
    throw fromTimeout(error, `${locator} disappeared when it was scrolled into view.`, 'FLOW_TARGET_MISSING')
  })
}

async function assertReceivesPointer(element, locator, point, handles) {
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
  if (!receivesPointer || !(await framesReceivePointer(element, point, handles))) {
    throw new TraceframeError(`${locator} is covered at the click point. If a dialog or toast covers it, wait until it closes; if a panel clips it or a sticky header or bar covers it, call scroll() on the target first.`, { code: 'FLOW_TARGET_OBSCURED' })
  }
}

async function framesReceivePointer(element, point, handles) {
  let frame = await element.ownerFrame()
  while (frame?.parentFrame()) {
    const frameElement = await frame.frameElement()
    handles.push(frameElement)
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
