#!/usr/bin/env node

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import { DEFAULTS, PRESETS } from './config.mjs'
import { LIMITS } from './flow.mjs'
import { formatFailure } from './diagnostics.mjs'
import { record } from './record.mjs'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
// Each flag and the record() option it sets. Flags without help are shown in the usage line.
// A new flag also needs its check in config.mjs and an entry in the README.
const OPTIONS = {
  url: { key: 'url' },
  flow: { key: 'flow' },
  out: { key: 'output', value: '<path>', help: `Output MP4 (default: ${DEFAULTS.output})` },
  preset: { key: 'preset', value: `<${Object.keys(PRESETS).join('|')}>`, help: Object.keys(PRESETS).map(describePreset) },
  browser: { key: 'browser', value: '<path>', help: 'Chromium executable (or set CHROME_PATH)' },
  gpu: { key: 'gpu', value: '<auto|off>', help: 'Verified GPU with software fallback (default), or software only' },
  'storage-state': { key: 'storageState', value: '<path>', help: 'Playwright storage state JSON' },
  'viewport-width': { key: 'viewportWidth', type: Number, value: '<pixels>', help: 'CSS viewport width' },
  'viewport-height': { key: 'viewportHeight', type: Number, value: '<pixels>', help: 'CSS viewport height' },
  scale: { key: 'scale', type: Number, value: '<1|2>', help: 'Device scale factor; the video is the viewport times this' },
  fps: { key: 'fps', type: Number, value: '<30|60>', help: 'Encoded frame rate' },
  'capture-quality': { key: 'captureQuality', type: Number, value: '<1–100>', help: `JPEG frame quality (default: ${DEFAULTS.captureQuality}); higher keeps more detail` },
  'capture-diagnostics': { key: 'captureDiagnostics', type: Boolean, help: 'Include frame delivery cadence and gaps in the JSON summary' },
  'post-roll': { key: 'postRoll', type: Number, value: '<seconds>', help: `Tail after the flow (default: ${DEFAULTS.postRoll})` },
  'ready-timeout': { key: 'readyTimeout', type: Number, value: '<seconds>', help: `Playwright default timeout during navigation and ready() (default: ${DEFAULTS.readyTimeout})` },
  'flow-timeout': { key: 'flowTimeout', type: Number, value: '<seconds>', help: `Time limit for the flow, including waits (default: ${DEFAULTS.flowTimeout})` },
  'run-dir': { key: 'runDirectory', value: '<path>', help: 'Keep the raw capture, failure screenshot and FFmpeg filter' },
  audio: { key: 'audio', value: '<path>', help: 'Add an external audio file (AAC stereo in the MP4)' },
  'audio-offset': { key: 'audioOffset', type: Number, value: '<seconds>', help: `Audio start in the video; negative trims its start (default: ${DEFAULTS.audioOffset})` },
}
const OPTION_HELP = [
  ...Object.entries(OPTIONS).filter(([, option]) => option.help).map(([flag, { value, help }]) => [`--${flag}${value ? ` ${value}` : ''}`, help]),
  ['-h, --help', 'Show this help'],
  ['-v, --version', 'Show the version'],
].flatMap(([label, help]) => [help].flat().map((line, index) => `  ${(index ? '' : label).padEnd(29)}${line}`))
const HELP = `traceframe ${VERSION}

Record a scripted Chromium flow and render a smooth cursor and click pulse.

Usage:
  traceframe record --url <url> --flow <flow.mjs> [--out <video.mp4>] [options]

Options:
${OPTION_HELP.join('\n')}

The flow module must export a default function. It may also export
ready({ page, signal }) to establish state before capture and initialPointer
{ x, y } to set where the cursor starts.
The flow helpers are move(), hover(), click(), scroll(), and wait(). A flow
may contain at most ${LIMITS.maxMoves} move events and ${LIMITS.maxClicks} click events.
Each duration, dwell, and wait is at most ${LIMITS.maxActionDuration} seconds.
`

const interruption = new AbortController()
let interruptedBy
for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    if (interruption.signal.aborted) process.exit(exitCode)
    interruptedBy = signal
    process.stderr.write(`traceframe: Stopping and cleaning up.${signal === 'SIGINT' ? ' Press Ctrl-C again to exit now.' : ''}\n`)
    interruption.abort()
  })
}

try {
  await main()
} catch (error) {
  if (interruptedBy) {
    process.stderr.write('traceframe: Recording was interrupted.\n')
    process.exitCode = SIGNAL_EXIT_CODES[interruptedBy]
  } else {
    process.stderr.write(formatFailure(error))
    process.exitCode = 1
  }
}

function describePreset(name) {
  const { viewport: { width, height }, scale, fps } = PRESETS[name]
  return `${name}: ${width}x${height} CSS viewport, ${width * scale}x${height * scale} at ${fps} FPS${name === DEFAULTS.preset ? ' (default)' : ''}`
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2))
  if (parsed.help) return process.stdout.write(HELP)
  if (parsed.version) return process.stdout.write(`${VERSION}\n`)
  const summary = await record({ ...parsed.options, signal: interruption.signal })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

function parseCommand(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      ...Object.fromEntries(Object.entries(OPTIONS).map(([flag, { type }]) => [flag, { type: type === Boolean ? 'boolean' : 'string' }])),
    },
  })
  if (values.help || args.length === 0) return { help: true }
  if (values.version) return { version: true }
  const [command, ...rest] = positionals
  if (command !== 'record') throw new Error('Expected the record command. Use "traceframe record --help".')
  if (rest.length) throw new Error(`Unexpected argument: ${rest[0]}`)

  const options = {}
  for (const [flag, { key, type }] of Object.entries(OPTIONS)) {
    if (values[flag] !== undefined) options[key] = type === Number ? Number(values[flag]) : values[flag]
  }
  if (options.audio !== undefined || options.audioOffset !== undefined) {
    options.audio = { path: options.audio, offset: options.audioOffset }
    delete options.audioOffset
  }
  return { options }
}
