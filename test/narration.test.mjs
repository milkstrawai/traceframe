import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { runCommand } from '../src/ffmpeg.mjs'
import { createTrace, secondsSince } from '../src/flow.mjs'
import { createNarration } from '../src/narration.mjs'
import { noise } from './helpers.mjs'

const RATE = 8000
const LINE = 'Open the settings, then press Save.'
const clip = (...seconds) => noise(RATE, ...seconds)
// Timers can end a millisecond before they are due by the clock, and tens of milliseconds after on a busy machine.
const EARLY = 0.002
const LATE = 0.15

// A narration whose clips come from `clips` by text, after `latency` seconds, with a flow clock that started
// `elapsed` seconds ago. click() moves for `move` seconds (its duration unless set), dwells, waits for its line's
// `beforePress`, and returns when it pressed, as the flow's click does.
function setup({ clips, latency = 0, elapsed = 0, move, drawCaptions } = {}) {
  const narration = createNarration({ rate: RATE, speak: async (text) => { await delay(latency * 1000); return clips[text] }, drawCaptions })
  const clock = Date.now() - elapsed * 1000
  const clicks = []
  const click = async (target, { duration = 0.5, dwell = 0.25 }, line) => {
    const setOff = secondsSince(clock)
    await delay(((move ?? duration) + dwell) * 1000)
    await line.beforePress()
    line.signal.throwIfAborted()
    clicks.push({ target, setOff, at: secondsSince(clock) })
    return clicks.at(-1).at
  }
  return { narration, clock, clicks, say: narration.narrator({ clock, click }) }
}

test('speaks from the call and returns after the speech, a short gap and the actions alongside', async () => {
  const { narration, say, clock } = setup({ clips: { 'Hello.': clip(0, 0.4), 'Next.': clip(0, 0.2) } })
  await say('Hello.')
  const afterFirst = secondsSince(clock)
  assert.ok(afterFirst >= 0.7 - EARLY && afterFirst < 1.2, `returned after ${afterFirst}`)
  assert.ok(narration.lines[0].start < LATE)
  await say('Next.', () => delay(600))
  assert.ok(secondsSince(clock) - afterFirst >= 0.6 - EARLY)
  assert.ok(Math.abs(narration.lines[1].start - afterFirst) < LATE)
})

// "then" starts 1.35 seconds into this clip, about where the text alone puts it.
const THEN_AT_1_35 = clip(0.25, 0.8, 0.3, 0.9, 0.4)

test('presses as the clicked word is said', async () => {
  const { narration, say, clicks, clock } = setup({ clips: { [LINE]: THEN_AT_1_35 }, elapsed: 5 })
  const calledAt = secondsSince(clock)
  await say(LINE, { click: 'Save button', on: 'then', duration: 0.2, dwell: 0 })
  const [line] = narration.lines
  assert.equal(clicks[0].target, 'Save button')
  assert.ok(Math.abs(line.start + 1.35 - clicks[0].at) < 1e-9)
  assert.ok(line.start - calledAt >= -EARLY && line.start - calledAt < LATE)
})

test('sets off for a clicked word by the text guess while the audio is not ready yet', async () => {
  const { narration, say, clicks, clock } = setup({ clips: { [LINE]: THEN_AT_1_35 }, latency: 1.5, elapsed: 5 })
  const calledAt = secondsSince(clock)
  await say(LINE, { click: {}, on: 'then', duration: 0.2, dwell: 0 })
  assert.ok(clicks[0].setOff - calledAt < 1.4)
  // The press waits for the audio, so the line starts a little after the call.
  assert.ok(Math.abs(narration.lines[0].start + 1.35 - clicks[0].at) < 1e-9)
  assert.ok(clicks[0].at - calledAt >= 1.49)
})

test('waits on the target when the pointer is already there', async () => {
  const { narration, say, clicks, clock } = setup({ clips: { 'First.': clip(0, 0.5), [LINE]: THEN_AT_1_35 }, elapsed: 5, move: 0 })
  await say('First.')
  const calledAt = secondsSince(clock)
  await say(LINE, { click: {}, on: 'then', duration: 0.8 })
  const [first, second] = narration.lines
  assert.ok(second.start >= calledAt - EARLY && second.start - calledAt < LATE, `started ${second.start - calledAt} s after the call`)
  assert.ok(second.start >= first.start + 0.5)
  assert.ok(Math.abs(second.start + 1.35 - clicks[0].at) < 1e-9)
})

test('speaks one line at a time, even when a say() is not awaited', async () => {
  const { narration, say } = setup({ clips: { 'One.': clip(0, 0.5), [LINE]: THEN_AT_1_35 }, elapsed: 5 })
  const first = say(LINE, { click: {}, on: 'then', duration: 0.2, dwell: 0 })
  await Promise.all([first, say('One.')])
  const [clicked, plain] = narration.lines
  assert.equal(clicked.text, LINE)
  assert.ok(plain.start >= clicked.start + THEN_AT_1_35.length / RATE + 0.3 - EARLY)
})

test('refuses a say() it cannot follow', async () => {
  const { say } = setup({ clips: {} })
  await assert.rejects(say(''), { code: 'INVALID_FLOW', message: /needs the text/ })
  await assert.rejects(say(LINE, { on: 'Save' }), { code: 'INVALID_FLOW', message: /both click and on/ })
  await assert.rejects(say(LINE, { click: {} }), { code: 'INVALID_FLOW', message: /both click and on/ })
  await assert.rejects(say(LINE, { click: {}, on: 'Cancel' }), { code: 'INVALID_FLOW', message: /"Cancel" is not in/ })
  await assert.rejects(say(LINE, { caption: 'left' }), { code: 'INVALID_FLOW', message: /top or bottom/ })
})

test('rejects at once with a failing action, before the audio is ready', async () => {
  const { say, clock } = setup({ clips: { 'Hello.': clip(0, 0.2) }, latency: 0.5 })
  const failure = new Error('action failed')
  await assert.rejects(say('Hello.', async () => { throw failure }), (error) => error === failure)
  assert.ok(secondsSince(clock) < 0.3)
})

test('a failing action stops the click its line planned', async () => {
  const { say, clicks, clock } = setup({ clips: { [LINE]: THEN_AT_1_35 } })
  const failure = new Error('action failed')
  await assert.rejects(say(LINE, { click: {}, on: 'then', duration: 0.2, dwell: 0, during: async () => { await delay(100); throw failure } }), (error) => error === failure)
  assert.ok(secondsSince(clock) < 0.5)
  await delay(1500)
  assert.deepEqual(clicks, [])
})

for (const [kind, options] of [['plain', {}], ['clicked', { click: {}, on: 'Failing' }]]) {
  test(`after a failed ${kind} line that the flow catches, the next line waits for its audio and replaces it`, async () => {
    const { narration, say, clock } = setup({ clips: { 'Failing.': clip(0, 0.4), 'Next.': clip(0, 0.2) }, latency: 0.5 })
    const failure = new Error('action failed')
    await assert.rejects(say('Failing.', { ...options, during: async () => { throw failure } }), (error) => error === failure)
    await say('Next.')
    assert.deepEqual(narration.lines.map((line) => line.text), ['Next.'])
    assert.ok(narration.lines[0].start >= 0.45, `next line at ${narration.lines[0].start}`)
    assert.ok(secondsSince(clock) >= 1 - EARLY)
  })
}

test('a line whose action fails while it is spoken is left out, and the next line takes its place', async () => {
  const { narration, say } = setup({ clips: { 'Failing.': clip(0, 2), 'Next.': clip(0, 0.2) } })
  const failure = new Error('action failed')
  await assert.rejects(say('Failing.', async () => { await delay(300); throw failure }), (error) => error === failure)
  await say('Next.')
  assert.deepEqual(narration.lines.map((line) => line.text), ['Next.'])
  assert.ok(narration.lines[0].start < 0.3 + LATE, `next line at ${narration.lines[0].start}`)
})

test('lays the lines out on one track and places each caption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-narration-'))
  try {
    const bottom = (x, width) => ({ box: { x, y: 715, width, height: 53 }, image: { x: x - 24, y: 691 } })
    let drawn
    const drawCaptions = async (options) => {
      drawn = options
      return [bottom(400, 480), bottom(500, 280), bottom(500, 280)]
    }
    const clips = { 'One.': clip(0.1, 0.3, 0.1), 'Two.': clip(0.1, 0.3, 0.1), 'Three.': clip(0.1, 0.3, 0.1) }
    const { narration, say, clock } = setup({ clips, drawCaptions })
    const trace = createTrace({ x: 20, y: 20 })
    await say('One.')
    // Then an element in use sits where the captions would go at the bottom: the third moves to the top, but the
    // flow asks for the bottom for the second.
    trace.targets.push({ at: secondsSince(clock), box: { x: 560, y: 690, width: 160, height: 40 } })
    await say('Two.', { caption: 'bottom' })
    await say('Three.')
    const viewport = { width: 1280, height: 800 }
    const { audio, captions } = await narration.finish({ directory, trace, viewport, scale: 2, captions: true })

    assert.deepEqual(drawn, { texts: ['One.', 'Two.', 'Three.'], viewport, scale: 2, paths: captions.map((caption) => caption.path) })
    assert.deepEqual(captions.map(({ x, y }) => ({ x, y })), [{ x: 752, y: 1382 }, { x: 952, y: 1382 }, { x: 952, y: 16 }])
    assert.ok(captions.every(({ start, end }) => Math.abs(end - start - 0.5) < 1e-9))
    // The track says when each line is spoken, for turning other audio down under it.
    assert.deepEqual(audio.spoken, captions.map(({ start, end }) => ({ start, end })))
    // Each line is loud where it was placed and the track is quiet between the lines.
    const pcm = join(directory, 'narration.pcm')
    await runCommand('ffmpeg', ['-v', 'error', '-i', audio.path, '-ac', '1', '-ar', String(RATE), '-f', 's16le', pcm])
    const samples = new Int16Array((await readFile(pcm)).buffer)
    const loudness = (from, to) => Math.max(...samples.subarray(Math.round(from * RATE), Math.round(to * RATE)).map(Math.abs))
    for (const line of narration.lines) assert.ok(loudness(line.start + 0.15, line.start + 0.35) > 3000)
    assert.ok(loudness(narration.lines[0].start + 0.55, narration.lines[1].start + 0.05) < 300)
    assert.deepEqual(await narration.finish({ directory, trace, viewport, scale: 2, captions: false }), { audio })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stops drawing captions when the recording is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-narration-'))
  try {
    // The recording is cancelled once drawing has started, and drawing never ends by itself.
    const cancel = new AbortController()
    const drawCaptions = () => {
      cancel.abort()
      return new Promise(() => {})
    }
    const { narration, say } = setup({ clips: { 'One.': clip(0, 0.2) }, drawCaptions })
    await say('One.')
    const finishing = narration.finish({ directory, trace: createTrace({ x: 0, y: 0 }), viewport: { width: 320, height: 240 }, scale: 1, captions: true, signal: cancel.signal })
    await assert.rejects(finishing, { name: 'AbortError' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('makes no track when the flow says nothing', async () => {
  const { narration } = setup({ clips: {} })
  assert.deepEqual(await narration.finish({ directory: tmpdir(), captions: true }), {})
})
