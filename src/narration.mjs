import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { captionY } from './captions.mjs'
import { raceAbort } from './deadline.mjs'
import { TraceframeError } from './errors.mjs'
import { runCommand } from './ffmpeg.mjs'
import { DWELL_SECONDS, MOVE_SECONDS, secondsSince } from './flow.mjs'
import { guessFromText, wordIndex, wordStart } from './word-timing.mjs'

// Quiet after a line before say() returns.
const GAP = 0.3

// The lines a flow says. `speak(text)` resolves to a line's Float32 samples at `rate`, and `drawCaptions` saves the
// caption images (see captions.mjs).
export function createNarration({ rate, speak, drawCaptions }) {
  // Each line's text, samples, start (seconds from the first frame) and caption position.
  const lines = []

  // The flow's say() helper. `click(locator, options, line)` is the flow's click: it waits for `line.beforePress`
  // before it presses, does not press once `line.signal` aborts, and returns when it pressed.
  function narrator({ clock, signal: flowSignal, click }) {
    // Lines are spoken one at a time: each waits for the speech before it to end and its audio to be made, even when
    // a say() is not awaited or an earlier one failed.
    let turn = Promise.resolve()

    // Starts a line's speech and its action together.
    function startLine(text, { during, target, index, duration, dwell, caption }) {
      flowSignal?.throwIfAborted()
      const calledAt = secondsSince(clock)
      const audio = speak(text)
      // A failed action stops the line's waits, its planned click and its speech.
      const stop = new AbortController()
      const signal = flowSignal ? AbortSignal.any([flowSignal, stop.signal]) : stop.signal
      const sleepUntil = (seconds, options) => delay(Math.max(0, seconds - secondsSince(clock)) * 1000, undefined, { signal, ...options })
      const action = Promise.resolve().then(during)
      action.catch((error) => stop.abort(error))

      async function speech() {
        let start = calledAt
        if (index !== undefined) {
          const lead = (duration ?? MOVE_SECONDS) + (dwell ?? DWELL_SECONDS)
          // Set off when the word is due: by the text's guess, or by the audio's once it is ready. The guess's timer
          // need not keep Node running once the audio wins.
          const ready = await Promise.race([audio, sleepUntil(calledAt + guessFromText(text, index) - lead, { ref: false })])
          if (ready) await sleepUntil(calledAt + wordStart(text, index, ready, rate) - lead)
          // Press as the word is said, and never so early that the line would start before its turn.
          let wordAt
          const pressAt = await click(target, { duration, dwell }, {
            signal,
            async beforePress() {
              wordAt = wordStart(text, index, await audio, rate)
              await sleepUntil(calledAt + wordAt)
            },
          })
          start = pressAt - wordAt
        }
        const samples = await audio
        // Only a line spoken to its end goes on the track, so a failed line never overlaps the next.
        await sleepUntil(start + samples.length / rate + GAP)
        lines.push({ text, samples, start, caption })
      }
      return { speech: speech(), audio, action }
    }

    return async function say(text, options = {}) {
      const { during, click: target, on, duration, dwell, caption } = typeof options === 'function' ? { during: options } : options
      if (typeof text !== 'string' || !text.trim()) throw new TraceframeError('say() needs the text to speak.', { code: 'INVALID_FLOW' })
      if ((target === undefined) !== (on === undefined)) throw new TraceframeError('say() needs both click and on to click as a word is said.', { code: 'INVALID_FLOW' })
      const index = on === undefined ? undefined : wordIndex(text, on)
      if (index < 0) throw new TraceframeError(`say() can click only on a word in the line: "${on}" is not in "${text}".`, { code: 'INVALID_FLOW' })
      if (![undefined, 'top', 'bottom'].includes(caption)) throw new TraceframeError('say() caption must be top or bottom.', { code: 'INVALID_FLOW' })
      const line = turn.then(() => startLine(text, { during, target, index, duration, dwell, caption }))
      turn = line.then(({ speech, audio }) => Promise.allSettled([speech, audio])).catch(() => {})
      const { speech, action } = await line
      await Promise.all([speech, action])
    }
  }

  // After the take: the narration track, and with `captions`, one caption image per line and where it goes.
  async function finish({ directory, trace, viewport, scale, captions, signal }) {
    if (!lines.length) return {}
    const track = new Float32Array(Math.max(...lines.map((line) => Math.round(line.start * rate) + line.samples.length)))
    for (const line of lines) track.set(line.samples, Math.round(line.start * rate))
    const audio = { path: join(directory, 'narration.wav'), offset: 0 }
    await runCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', audio.path], { signal, input: new Uint8Array(track.buffer) })
    if (!captions) return { audio }

    const paths = lines.map((_, index) => join(directory, `caption-${index}.png`))
    const drawing = drawCaptions({ texts: lines.map((line) => line.text), viewport, scale, paths })
    const drawn = await (signal ? raceAbort(drawing, signal) : drawing)
    return {
      audio,
      captions: lines.map((line, index) => {
        const { box, image } = drawn[index]
        const end = line.start + line.samples.length / rate
        const y = captionY({ start: line.start, end, box, position: line.caption }, trace, viewport)
        return { path: paths[index], start: line.start, end, x: Math.round(image.x * scale), y: Math.round((image.y + y - box.y) * scale) }
      }),
    }
  }

  return { narrator, finish, lines }
}
