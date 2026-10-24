#!/usr/bin/env node

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import { LIMITS } from './flow.mjs'
import { record } from './record.mjs'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const OPTION_KEYS = {
  url: 'url',
  flow: 'flow',
  out: 'output',
  preset: 'preset',
  browser: 'browser',
  'storage-state': 'storageState',
  'viewport-width': 'viewportWidth',
  'viewport-height': 'viewportHeight',
  scale: 'scale',
  fps: 'fps',
  'post-roll': 'postRoll',
  'ready-timeout': 'readyTimeout',
  'flow-timeout': 'flowTimeout',
  'run-dir': 'runDirectory',
}
const NUMBER_KEYS = new Set(['viewportWidth', 'viewportHeight', 'scale', 'fps', 'postRoll', 'readyTimeout', 'flowTimeout'])
const HELP = `traceframe ${VERSION}

Record a scripted Chromium flow and render a smooth cursor and click pulse.

Usage:
  traceframe record --url <url> --flow <flow.mjs> [--out <video.mp4>] [options]

Options:
  --preset <standard|draft>    standard: 1280x800 CSS viewport, 2560x1600 at 60 FPS (default)
                               draft: 1280x800 CSS viewport, 1280x800 at 30 FPS
  --browser <path>             Chromium executable (or set CHROME_PATH)
  --storage-state <path>       Playwright storage state JSON
  --viewport-width <pixels>    CSS viewport width
  --viewport-height <pixels>   CSS viewport height
  --scale <1|2>                Device scale factor; the video is the viewport times this
  --fps <30|60>                Encoded frame rate
  --post-roll <seconds>        Tail after the flow (default: 0.3)
  --ready-timeout <seconds>    Playwright timeout for the page load and calls in ready() (default: 30)
  --flow-timeout <seconds>     Time limit for the flow, including waits (default: 120)
  --run-dir <path>             Keep the raw capture and FFmpeg filter in this directory
  -h, --help                   Show this help
  -v, --version                Show the version

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
    process.stderr.write(`traceframe: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
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
      ...Object.fromEntries(Object.keys(OPTION_KEYS).map((name) => [name, { type: 'string' }])),
    },
  })
  if (values.help || args.length === 0) return { help: true }
  if (values.version) return { version: true }
  const [command, ...rest] = positionals
  if (command !== 'record') throw new Error('Expected the record command. Use "traceframe record --help".')
  if (rest.length) throw new Error(`Unexpected argument: ${rest[0]}`)

  const options = {}
  for (const [name, key] of Object.entries(OPTION_KEYS)) {
    if (values[name] !== undefined) options[key] = NUMBER_KEYS.has(key) ? Number(values[name]) : values[name]
  }
  return { options }
}
