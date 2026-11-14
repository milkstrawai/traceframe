import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const flowArgs = ['--url', 'file:///tmp/page.html', '--flow', fileURLToPath(new URL('../examples/fixture-flow.mjs', import.meta.url))]

async function run(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('prints the package version', async () => {
  assert.deepEqual(await run('--version'), { code: 0, stdout: `${version}\n`, stderr: '' })
})

test('help prints the whole usage text', async () => {
  assert.deepEqual(await run('--help'), { code: 0, stderr: '', stdout: `traceframe ${version}

Record a scripted Chromium flow and render a smooth cursor and click pulse.

Usage:
  traceframe record --url <url> --flow <flow.mjs> [--out <video.mp4>] [options]

Options:
  --out <path>                 Output MP4 (default: traceframe.mp4)
  --preset <standard|draft>    standard: 1280x800 CSS viewport, 2560x1600 at 60 FPS (default)
                               draft: 1280x800 CSS viewport, 1280x800 at 30 FPS
  --browser <path>             Chromium executable (or set CHROME_PATH)
  --gpu <auto|off>             Verified GPU with software fallback (default), or software only
  --storage-state <path>       Playwright storage state JSON
  --viewport-width <pixels>    CSS viewport width
  --viewport-height <pixels>   CSS viewport height
  --scale <1|2>                Device scale factor; the video is the viewport times this
  --fps <30|60>                Encoded frame rate
  --capture-quality <1–100>    JPEG frame quality (default: 85); higher keeps more detail
  --capture-diagnostics        Include frame delivery cadence and gaps in the JSON summary
  --post-roll <seconds>        Tail after the flow (default: 0.3)
  --ready-timeout <seconds>    Playwright default timeout during navigation and ready() (default: 30)
  --flow-timeout <seconds>     Time limit for the flow, including waits (default: 120)
  --run-dir <path>             Keep the raw capture, failure screenshot and FFmpeg filter
  --audio <path>               Add an external audio file (AAC stereo in the MP4)
  --audio-offset <seconds>     Audio start in the video; negative trims its start (default: 0)
  -h, --help                   Show this help
  -v, --version                Show the version

The flow module must export a default function. It may also export
ready({ page, signal }) to establish state before capture and initialPointer
{ x, y } to set where the cursor starts.
The flow helpers are move(), hover(), click(), scroll(), and wait(). A flow
may contain at most 100 move events and 100 click events.
Each duration, dwell, and wait is at most 30 seconds.
` })
})

test('rejects unknown options and missing values', async () => {
  assert.match((await run('record', '--output', 'video.mp4')).stderr, /^traceframe: Unknown option '--output'/)
  assert.match((await run('record', '--url')).stderr, /^traceframe: Option '--url <value>' argument missing/)
})

test('passes --out and numeric options through to the configuration', async () => {
  assert.match((await run('record', ...flowArgs, '--out', 'video.webm')).stderr, /Output path must use the \.mp4 extension/)
  assert.match((await run('record', ...flowArgs, '--fps', '45')).stderr, /FPS must be 30 or 60/)
  assert.match((await run('record', ...flowArgs, '--post-roll=-1')).stderr, /Post-roll must be 0 or more seconds/)
  // A string timeout would fail the config check, so reaching the flow loader proves the number conversion.
  assert.match((await run('record', '--url', 'file:///tmp/page.html', '--flow', 'missing-flow.mjs', '--flow-timeout', '300')).stderr, /Could not load flow/)
})

test('parses audio settings and explains incomplete or invalid offsets', async () => {
  const help = await run('--help')
  assert.match(help.stdout, /--audio <path>/)
  assert.match(help.stdout, /--audio-offset <seconds>/)
  assert.match((await run('record', ...flowArgs, '--audio-offset', '1')).stderr, /Audio must specify a local file path/)
  assert.match((await run('record', ...flowArgs, '--audio', 'sound.wav', '--audio-offset', 'never')).stderr, /Audio offset must be a finite number/)
})

test('parses capture quality as a number and capture diagnostics as a flag', async () => {
  assert.match((await run('record', ...flowArgs, '--capture-quality', '101')).stderr, /Capture quality must be an integer/)
  assert.match((await run('record', '--url', 'file:///tmp/page.html', '--flow', 'missing-flow.mjs', '--capture-quality', '80', '--capture-diagnostics')).stderr, /Could not load flow/)
})

test('parses GPU mode as a string option', async () => {
  assert.match((await run('--help')).stdout, /--gpu <auto\|off>/)
  assert.match((await run('record', ...flowArgs, '--gpu', 'on')).stderr, /GPU must be/)
  assert.match((await run('record', '--url', 'about:blank', '--flow', 'missing-flow.mjs', '--gpu', 'off')).stderr, /Could not load flow/)
})
