import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

import { record } from '../src/index.mjs'

const exec = promisify(execFile)

test('GPU fallback happens before ready and records one correctly sized take', { timeout: 45_000 }, async t => {
  const launch = chromium.launch.bind(chromium)
  const browsers = []
  const mock = t.mock.method(chromium, 'launch', async options => {
    // A real software browser stands in for a machine without working GPU access.
    const browser = await launch({ ...options, args: [...options.args.filter(arg => arg !== '--enable-gpu' && !arg.startsWith('--use-angle=')), '--disable-gpu'] })
    browsers.push(browser)
    return browser
  })
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-gpu-'))
  try {
    const page = join(directory, 'page.html'), flow = join(directory, 'flow.mjs')
    await writeFile(page, '<button style="margin:40px">Save</button>')
    await writeFile(flow, `export let preparations = 0, flows = 0
export async function ready({ page }) { preparations++; await page.getByRole('button').waitFor() }
export default async function ({ page, click, wait }) { flows++; await click(page.getByRole('button'), { duration: 0.05, dwell: 0 }); await wait(0.1) }
`)
    const summary = await record({ url: pathToFileURL(page).href, flow, output: join(directory, 'video.mp4'),
      viewportWidth: 320, viewportHeight: 240, preset: 'draft', scale: 2, postRoll: 0, captureDiagnostics: true })
    const module = await import(pathToFileURL(flow).href)
    assert.equal(module.preparations, 1)
    assert.equal(module.flows, 1)
    assert.equal(mock.mock.callCount(), 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
    const { fallbackReason, ...graphics } = summary.graphics
    assert.deepEqual(graphics, { hardwareAccelerated: false })
    // On Linux, the reason also depends on whether this account can open a GPU device.
    assert.ok(['software-rendering', 'gpu-device-unavailable'].includes(fallbackReason), fallbackReason)
    assert.equal(summary.clickCount, 1)
    assert.ok(summary.captureStats.framesReceived > 0)
    const probe = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', summary.output])
    assert.deepEqual(JSON.parse(probe.stdout).streams, [{ width: 640, height: 480 }])
    await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', summary.output, '-f', 'null', '-'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
