import test from 'node:test'
import assert from 'node:assert/strict'

import { guessFromText, wordIndex, wordStart } from '../src/word-timing.mjs'
import { noise } from './helpers.mjs'

const RATE = 8000

const clip = (...seconds) => noise(RATE, ...seconds)

test('finds a word in a line regardless of case and punctuation', () => {
  const line = 'Then press Save to keep the change.'
  assert.equal(wordIndex(line, 'Save'), 2)
  assert.equal(wordIndex(line, 'save'), 2)
  assert.equal(wordIndex(line, 'change'), 6)
  assert.equal(wordIndex('Go to settings, choose Billing, and update the card.', 'Billing'), 4)
  assert.equal(wordIndex('Click the Next.js tab.', 'Next.js'), 2)
  assert.equal(wordIndex('Open the billing page now.', 'billing page'), 2)
  assert.equal(wordIndex(line, 'Cancel'), -1)
  assert.equal(wordIndex(line, ''), -1)
})

test('guesses later words later from the text alone', () => {
  const line = 'Open the settings panel, then press Save.'
  const guesses = [0, 1, 2, 3, 4, 5, 6].map((index) => guessFromText(line, index))
  assert.equal(guesses[0], 0)
  assert.ok(guesses.every((guess, index) => index === 0 || guess > guesses[index - 1]))
  // A comma adds a pause after "panel".
  assert.ok(guesses[4] - guesses[3] > guesses[3] - guesses[2])
})

test('pins a pause in the audio to the comma that caused it', () => {
  const line = 'Open the settings, then press Save.'
  const audio = clip(0.1, 1, 0.3, 1.2, 0.5)
  assert.ok(Math.abs(wordStart(line, 0, audio, RATE) - 0.1) < 0.011)
  // "then" starts where the pause ends; the words after it share the second stretch of speech.
  assert.ok(Math.abs(wordStart(line, 3, audio, RATE) - 1.4) < 0.011)
  const save = wordStart(line, 5, audio, RATE)
  assert.ok(save > 1.8 && save < 2.6, `Save at ${save}`)
})

test('spreads the words over the speech when it has no pause', () => {
  const line = 'Then press Save to keep the change.'
  const audio = clip(0.05, 2, 0.5)
  const starts = [0, 1, 2, 3, 4, 5, 6].map((index) => wordStart(line, index, audio, RATE))
  assert.ok(Math.abs(starts[0] - 0.05) < 0.011)
  assert.ok(starts.every((start, index) => index === 0 || start > starts[index - 1]))
  assert.ok(starts[6] < 2.05)
})
