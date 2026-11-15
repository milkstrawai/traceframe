import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { record, recordPage } from '../src/index.mjs'
import { runCommand } from '../src/ffmpeg.mjs'

const viewport = { width: 640, height: 360 }
const PAGE = '<body style="margin: 0; background: #fff"><button style="position: absolute; left: 280px; top: 120px; width: 80px; height: 40px">Save</button>'
const flowSource = (voice) => `export const voice = ${voice}
export default async function ({ page, say }) {
  await say('This page has one button.')
  await say('Now press Save to finish.', { click: page.getByRole('button', { name: 'Save' }), on: 'Save' })
}
`

let directory
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'traceframe-voice-'))
  await writeFile(join(directory, 'page.html'), PAGE)
})
after(() => rm(directory, { recursive: true, force: true }))

async function narratedTake(name, voice) {
  const flow = join(directory, `${name}.mjs`)
  await writeFile(flow, flowSource(voice))
  const runDirectory = join(directory, `${name}-run`)
  const summary = await record({
    url: pathToFileURL(join(directory, 'page.html')).href, flow, output: join(directory, `${name}.mp4`),
    preset: 'draft', viewportWidth: viewport.width, viewportHeight: viewport.height, runDirectory,
  })
  return { summary, runDirectory, filter: await readFile(join(runDirectory, 'render.filter'), 'utf8') }
}

// The gray level at a point of the frame shown at `time`.
async function grayAt(video, time, { x, y }) {
  const { stdout } = await runCommand('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', video, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  return stdout[0]
}

test('narrates a take, presses as the word is said, and captions each line', async () => {
  const { summary, runDirectory, filter } = await narratedTake('captions', true)
  assert.equal(summary.lineCount, 2)
  assert.equal(summary.clickCount, 1)
  assert.equal(summary.audio, true)
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', summary.output])
  assert.equal(stdout.trim(), 'aac')

  // The press lands while the line is being spoken, not in the quiet around it.
  const press = Number(filter.match(/\[click0\]overlay=[^;]*between\(t,([\d.]+),/)[1])
  const pcm = join(directory, 'narration.pcm')
  await runCommand('ffmpeg', ['-v', 'error', '-i', join(runDirectory, 'narration.wav'), '-ac', '1', '-ar', '8000', '-f', 's16le', pcm])
  const samples = new Int16Array((await readFile(pcm)).buffer)
  const loudest = (from, to) => Math.max(...samples.subarray(Math.round(from * 8000), Math.round(to * 8000)).map(Math.abs))
  assert.ok(loudest(press - 0.05, press + 0.25) > 3000, `quiet at the press (${press} s)`)

  // Both captions are drawn at the bottom, out of the button's way, while their lines are spoken.
  const windows = [...filter.matchAll(/\[caption\d\]overlay=[^;]*between\(t,([\d.]+),([\d.]+)\)/g)].map((match) => [Number(match[1]), Number(match[2])])
  assert.equal(windows.length, 2)
  const bottom = { x: viewport.width / 2, y: viewport.height - 40 }
  assert.ok(await grayAt(summary.output, (windows[0][0] + windows[0][1]) / 2, bottom) < 60)
  assert.ok(await grayAt(summary.output, windows[1][1] + 0.2, bottom) > 200)
})

test('narrates without captions', async () => {
  const { summary, runDirectory, filter } = await narratedTake('silent-captions', '{ captions: false }')
  assert.equal(summary.lineCount, 2)
  assert.equal(summary.audio, true)
  assert.doesNotMatch(filter, /caption/)
  await assert.rejects(access(join(runDirectory, 'caption-0.png')))
  assert.ok(await grayAt(summary.output, 1, { x: viewport.width / 2, y: viewport.height - 40 }) > 200)
})

test('narrates a page the caller opened', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport })
    await page.setContent(PAGE)
    const summary = await recordPage({ page, output: join(directory, 'page.mp4'), voice: true, flow: async ({ say }) => say('Hello from an open page.') })
    assert.equal(summary.lineCount, 1)
    assert.equal(summary.audio, true)
    assert.ok(summary.duration > 1.5)
  } finally {
    await browser.close()
  }
})

test('a narrated flow cannot also take audio', async () => {
  const flow = join(directory, 'with-audio.mjs')
  await writeFile(flow, flowSource(true))
  await assert.rejects(record({ url: 'about:blank', flow, output: join(directory, 'with-audio.mp4'), audio: { path: join(directory, 'sound.wav') } }), { code: 'INVALID_CONFIG', message: /narrated flow/ })
})
