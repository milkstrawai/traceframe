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

test('rejects unknown options and missing values', async () => {
  assert.match((await run('record', '--output', 'video.mp4')).stderr, /^traceframe: Unknown option '--output'/)
  assert.match((await run('record', '--url')).stderr, /^traceframe: Option '--url <value>' argument missing/)
})

test('passes --out and numeric options through to the configuration', async () => {
  assert.match((await run('record', ...flowArgs, '--out', 'video.webm')).stderr, /Output path must use the \.mp4 extension/)
  assert.match((await run('record', ...flowArgs, '--fps', '45')).stderr, /FPS must be 30 or 60/)
  assert.match((await run('record', ...flowArgs, '--post-roll=-1')).stderr, /Post-roll must be 0 or more seconds/)
})
