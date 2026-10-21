import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'traceframe-package-'))

try {
  const { stdout: packed } = await run('npm', ['pack', '--json', '--pack-destination', directory], { cwd: root })
  const { filename } = Object.values(JSON.parse(packed))[0]
  await writeFile(join(directory, 'package.json'), '{ "private": true, "type": "module" }\n')
  await run('npm', ['install', '--no-audit', '--no-fund', join(directory, filename)], { cwd: directory })

  const bin = join(directory, 'node_modules', '.bin', 'traceframe')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal((await run(bin, ['--version'])).stdout, `${version}\n`)
  assert.equal((await run(process.execPath, ['--input-type=module', '-e', 'const { record } = await import("traceframe"); console.log(typeof record)'], { cwd: directory })).stdout, 'function\n')

  const { stdout } = await run(bin, [
    'record', '--preset', 'draft',
    '--url', pathToFileURL(join(root, 'examples', 'fixture.html')).href,
    '--flow', join(root, 'examples', 'fixture-flow.mjs'),
    '--out', join(directory, 'sample.mp4'),
  ], { cwd: directory })
  const summary = JSON.parse(stdout)
  assert.equal(summary.clickCount, 5)
  console.log(JSON.stringify({ package: filename, duration: summary.duration }))
} finally {
  await rm(directory, { recursive: true, force: true })
}
