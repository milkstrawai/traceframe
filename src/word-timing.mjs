// Phonon gives no word timings, so where a word starts in a spoken line is guessed from the text and the audio.
// Each word gets a weight from its letters and syllables, and a comma or full stop adds a pause. The weights are
// spread over the clip's voiced time, with the clip's own pauses pinned to the punctuation that caused them.
// The weights were fitted to forced alignments of 44 narration lines in Phonon's default voice. On 24 other lines,
// word starts were a median 0.05 seconds off and at most 0.21 seconds.

const WEIGHT = { syllable: 0.5, letter: 1, word: 0.75, smallWord: 0.6, first: 3.25, last: 0.5, comma: 4.6, stop: 3.2 }
// Typical voiced seconds per unit of weight, for a guess before the audio exists (about 15% either way).
const SECONDS_PER_WEIGHT = 0.052
// Speech starts and ends where it is louder than this, below the loudest 10 ms.
const QUIET_DB = -45
// A pause is at least this long and this much quieter than the loudest 10 ms. It belongs to the nearest punctuation
// within PAUSE_REACH seconds of where the weights put it.
const PAUSE = { db: -28, seconds: 0.12 }
const PAUSE_REACH = 0.6
// Short words that are said quickly.
const SMALL_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'it', 'is', 'you', 'your', 'by', 'as', 'so', 'if', 'from', 'with', 'into', 'then'])
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

// The index of `word` (one word or several) among the words of `text`, or -1.
export function wordIndex(text, word) {
  const list = words(text).map(({ core }) => core.toLowerCase())
  const wanted = words(word).map(({ core }) => core.toLowerCase())
  if (!wanted.length) return -1
  return list.findIndex((_, index) => wanted.every((part, offset) => list[index + offset] === part))
}

// Seconds from the start of the spoken line to word `index`, before the audio exists.
export function guessFromText(text, index) {
  return layout(words(text)).at[index] * SECONDS_PER_WEIGHT
}

// Seconds from the start of `audio` to where word `index` of `text` starts.
export function wordStart(text, index, audio, rate) {
  const levels = decibels(audio, rate)
  const loudest = Math.max(...levels)
  const first = levels.findIndex((level) => level > loudest + QUIET_DB)
  const last = levels.findLastIndex((level) => level > loudest + QUIET_DB)
  const start = first / 100
  const end = (last + 1) / 100
  const list = words(text)
  const { cost, gapAfter, at, total } = layout(list)
  const scale = (weight) => start + ((end - start) * weight) / total

  // Match each pause in the audio, in order, to the nearest punctuation that is still free.
  const breaks = list.flatMap((_, word) => (gapAfter[word] ? [{ word, middle: at[word] + cost[word] + gapAfter[word] / 2 }] : []))
  const anchors = []
  let next = 0
  for (const pause of pauses(levels, loudest)) {
    let best = -1
    let distance = PAUSE_REACH
    for (let k = next; k < breaks.length; k++) {
      const gap = Math.abs(scale(breaks[k].middle) - (pause.start + pause.end) / 2)
      if (gap < distance) [best, distance] = [k, gap]
    }
    if (best < 0) continue
    anchors.push({ word: breaks[best].word, ...pause })
    next = best + 1
  }

  // Spread the weights over the stretch between the pauses on either side of the word.
  let from = { weight: 0, seconds: start }
  let to = { weight: total, seconds: end }
  for (const anchor of anchors) {
    if (anchor.word < index) from = { weight: at[anchor.word + 1], seconds: anchor.end }
    else {
      to = { weight: at[anchor.word] + cost[anchor.word], seconds: anchor.start }
      break
    }
  }
  return from.seconds + ((to.seconds - from.seconds) * (at[index] - from.weight)) / (to.weight - from.weight)
}

// Each word as it is said: its letters and syllables, with numbers and short capitalized abbreviations spelled out,
// and the pause its punctuation asks for.
function words(text) {
  return (text.match(/\S+/g) ?? []).map((token) => {
    const core = token.replace(/^[^\w$]+|[^\w%]+$/g, '')
    let said = core
    if (/^\d+$/.test(core)) said = numberWords(Number(core))
    else if (/^\$\d+$/.test(core)) said = `${numberWords(Number(core.slice(1)))} dollars`
    else if (/^[A-Z]{2,5}s?$/.test(core)) said = [...core.replace(/s$/, '')].map((letter) => (letter === 'W' ? 'double you' : `${letter}e`)).join(' ')
    const parts = said.split(/[\s./-]+/).filter(Boolean)
    const after = token.slice(token.indexOf(core) + core.length)
    return {
      core,
      syllables: parts.reduce((sum, part) => sum + syllables(part), 0) || 1,
      letters: parts.join('').replace(/[^a-z]/gi, '').length || 1,
      stop: /[.!?]/.test(after) ? 'stop' : /[,;:]|[—–-]$/.test(after) ? 'comma' : undefined,
    }
  })
}

// Each word's weight, the pause weight after it, and where each word starts on the weight scale (0 to `total`).
function layout(list) {
  const cost = list.map((word, index) => (WEIGHT.syllable * word.syllables + WEIGHT.letter * word.letters + WEIGHT.word)
    * (SMALL_WORDS.has(word.core.toLowerCase()) ? WEIGHT.smallWord : 1)
    + (index === 0 ? WEIGHT.first : 0) + (index === list.length - 1 ? WEIGHT.last : 0))
  const gapAfter = list.map((word, index) => (index < list.length - 1 && word.stop ? WEIGHT[word.stop] : 0))
  const at = []
  let total = 0
  for (const [index, weight] of cost.entries()) {
    at.push(total)
    total += weight + gapAfter[index]
  }
  return { cost, gapAfter, at, total }
}

// Quiet stretches between the first and last loud 10 ms, as { start, end } in seconds.
function pauses(levels, loudest) {
  const loud = levels.map((level) => level > loudest + PAUSE.db)
  const last = loud.lastIndexOf(true)
  const found = []
  for (let index = loud.indexOf(true); index <= last; index++) {
    if (loud[index]) continue
    let end = index
    while (end < loud.length && !loud[end]) end++
    if ((end - index) / 100 >= PAUSE.seconds) found.push({ start: index / 100, end: end / 100 })
    index = end
  }
  return found
}

// The level of each 10 ms of audio, in decibels.
function decibels(audio, rate) {
  const size = Math.round(rate / 100)
  const levels = []
  for (let start = 0; start + size <= audio.length; start += size) {
    let sum = 0
    for (let index = start; index < start + size; index++) sum += audio[index] ** 2
    levels.push(10 * Math.log10(sum / size + 1e-12))
  }
  return levels
}

function syllables(word) {
  let letters = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!letters) return 0
  if (letters.length <= 3) return 1
  letters = letters.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  return Math.max(1, (letters.match(/[aeiouy]{1,2}/g) ?? []).length)
}

function numberWords(number) {
  if (number < 20) return ONES[number]
  if (number < 100) return `${TENS[Math.floor(number / 10)]}${number % 10 ? ` ${ONES[number % 10]}` : ''}`
  if (number < 1000) return `${ONES[Math.floor(number / 100)]} hundred${number % 100 ? ` ${numberWords(number % 100)}` : ''}`
  if (number < 1e6) return `${numberWords(Math.floor(number / 1000))} thousand${number % 1000 ? ` ${numberWords(number % 1000)}` : ''}`
  return [...String(number)].map((digit) => ONES[digit]).join(' ')
}
