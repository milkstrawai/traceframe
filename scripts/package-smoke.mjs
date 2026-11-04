import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
// Invoke npm and the installed CLI through Node, including on Windows (.cmd shims).
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this check with npm run test:package.')
const directory = await mkdtemp(join(tmpdir(), 'traceframe package ü-'))

try {
  const { stdout: packed } = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', directory], { cwd: root })
  const { filename } = Object.values(JSON.parse(packed))[0]
  await writeFile(join(directory, 'package.json'), '{ "private": true, "type": "module" }\n')
  await run(process.execPath, [npm, 'install', '--no-audit', '--no-fund', join(directory, filename)], { cwd: directory })

  const installed = join(directory, 'node_modules', '@milkstraw', 'traceframe')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  const bin = join(installed, manifest.bin.traceframe)
  const examples = join(directory, 'node_modules', '@milkstraw', 'traceframe', 'examples')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal((await run(process.execPath, [bin, '--version'])).stdout, `${version}\n`)
  assert.equal((await run(process.execPath, ['--input-type=module', '-e', 'const { record, recordPage } = await import("@milkstraw/traceframe"); console.log(typeof record, typeof recordPage)'], { cwd: directory })).stdout, 'function function\n')

  const audio = join(directory, 'sound.wav')
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio])
  const { stdout } = await run(process.execPath, [bin,
    'record', '--preset', 'draft',
    '--url', pathToFileURL(join(examples, 'recipes.html')).href,
    '--flow', join(examples, 'recipes-flow.mjs'),
    '--audio', audio, '--audio-offset', '0.5',
    '--capture-quality', '80', '--capture-diagnostics',
    '--run-dir', join(directory, 'capture ü'),
    '--out', join(directory, 'sample.mp4'),
  ], { cwd: directory })
  const summary = JSON.parse(stdout)
  assert.equal(summary.clickCount, 5)
  assert.equal(summary.moveCount, 6)
  assert.equal(summary.audio, true)
  assert.ok(summary.captureStats.framesReceived > 0)
  assert.ok(summary.captureStats.writeWaitMs >= summary.captureStats.maxWriteWaitMs)
  const audioStream = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', summary.output])
  assert.equal(audioStream.stdout.trim(), 'aac')
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', summary.output, '-f', 'null', '-'])
  const { stdout: pageOutput } = await run(process.execPath, [join(examples, 'existing-page.mjs'), join(directory, 'existing-page.mp4')], { cwd: directory })
  const pageSummary = JSON.parse(pageOutput)
  assert.equal(pageSummary.clickCount, 2)
  assert.equal(pageSummary.width, 1280)
  assert.equal(pageSummary.height, 800)
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', pageSummary.output, '-f', 'null', '-'])
  console.log(JSON.stringify({ package: filename, duration: summary.duration, existingPageDuration: pageSummary.duration }))
} finally {
  await rm(directory, { recursive: true, force: true })
}
