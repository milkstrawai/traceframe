import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { record } from '../src/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const preset = process.env.TRACEFRAME_PRESET ?? 'draft'
const runDirectory = await mkdtemp(join(tmpdir(), 'traceframe-smoke-'))

try {
  const summary = await record({
    url: pathToFileURL(join(root, 'examples', 'fixture.html')).href,
    flow: join(root, 'examples', 'fixture-flow.mjs'),
    output: join(runDirectory, 'sample.mp4'),
    preset,
  })

  const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', summary.output])
  assert.equal(stdout.trim(), `${summary.width},${summary.height},${summary.fps}/1`)
  assert.ok(summary.duration >= 8)
  assert.equal(summary.clickCount, 5)
  assert.equal(summary.moveCount, 5)
  console.log(JSON.stringify({ preset, video: stdout.trim(), duration: summary.duration }))
} finally {
  await rm(runDirectory, { recursive: true, force: true })
}
