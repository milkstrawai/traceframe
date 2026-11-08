import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

import { record } from '../src/index.mjs'

const exec = promisify(execFile)

async function fixture(source, run) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-gpu-'))
  try {
    const page = join(directory, 'page.html'), flow = join(directory, 'flow.mjs')
    await writeFile(page, '<button style="margin:40px">Save</button>')
    await writeFile(flow, source)
    await run({ directory, flow, options: {
      url: pathToFileURL(page).href, flow, output: join(directory, 'video.mp4'),
      viewportWidth: 320, viewportHeight: 240, preset: 'draft', postRoll: 0,
    } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function forceSoftwareCandidate(t) {
  const launch = chromium.launch.bind(chromium)
  const browsers = []
  const mock = t.mock.method(chromium, 'launch', async options => {
    // A real software browser stands in for a machine without working GPU access.
    const browser = await launch({ ...options, args: [...options.args.filter(arg => arg !== '--enable-gpu' && !arg.startsWith('--use-angle=')), '--disable-gpu'] })
    browsers.push(browser)
    return browser
  })
  return { mock, browsers }
}

test('GPU fallback happens before ready and records one correctly sized take', { timeout: 45_000 }, async t => {
  const { mock, browsers } = forceSoftwareCandidate(t)
  const source = `export let preparations = 0, flows = 0
export async function ready({ page }) { preparations++; await page.getByRole('button').waitFor() }
export default async function ({ page, click, wait }) { flows++; await click(page.getByRole('button'), { duration: 0.05, dwell: 0 }); await wait(0.1) }
`
  await fixture(source, async ({ options, flow }) => {
    const summary = await record({ ...options, gpu: 'auto', scale: 2, captureDiagnostics: true })
    const module = await import(pathToFileURL(flow).href)
    assert.equal(module.preparations, 1)
    assert.equal(module.flows, 1)
    assert.equal(mock.mock.callCount(), 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
    assert.equal(summary.graphics.requested, 'auto')
    assert.equal(summary.graphics.hardwareAccelerated, false)
    assert.equal(summary.graphics.fallbackReason, 'software-rendering')
    assert.equal(summary.clickCount, 1)
    assert.ok(summary.captureStats.framesReceived > 0)
    const probe = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', summary.output])
    assert.deepEqual(JSON.parse(probe.stdout).streams, [{ width: 640, height: 480 }])
    await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', summary.output, '-f', 'null', '-'])
  })
})

test('a flow failure after fallback is not retried and closes both browsers', { timeout: 45_000 }, async t => {
  const { mock, browsers } = forceSoftwareCandidate(t)
  await fixture("export let calls = 0; export default () => { calls++; throw new Error('synthetic flow failure') }", async ({ options, flow, directory }) => {
    await assert.rejects(record({ ...options, gpu: 'auto', runDirectory: join(directory, 'run') }), { code: 'FLOW_FAILED', message: 'synthetic flow failure' })
    assert.equal((await import(pathToFileURL(flow).href)).calls, 1)
    assert.equal(mock.mock.callCount(), 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
    assert.deepEqual((await readdir(join(directory, 'run'))).sort(), ['capture.mkv', 'failure.png'])
  })
})

test('cancellation after GPU fallback keeps the caller reason and removes temporary work', { timeout: 45_000 }, async t => {
  const { mock, browsers } = forceSoftwareCandidate(t)
  const source = `export const controller = new AbortController(), reason = new Error('cancel GPU take')
export default async () => { controller.abort(reason); await new Promise(() => {}) }`
  await fixture(source, async ({ options, flow, directory }) => {
    const module = await import(pathToFileURL(flow).href)
    await assert.rejects(record({ ...options, gpu: 'auto', signal: module.controller.signal }), error => error === module.reason)
    assert.equal(mock.mock.callCount(), 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
    assert.deepEqual((await readdir(directory)).sort(), ['flow.mjs', 'page.html'])
  })
})
