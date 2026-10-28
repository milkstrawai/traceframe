import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const exec = promisify(execFile)

async function withFixture(source, check) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-cli-'))
  try {
    const flow = join(directory, 'flow.mjs')
    const page = join(directory, 'page.html')
    const runDirectory = join(directory, 'run')
    await writeFile(flow, source)
    await writeFile(page, '<h1>Example workspace</h1><button>Save</button>')
    const run = async (...extra) => {
      try {
        const result = await exec(process.execPath, [cli, 'record', '--url', pathToFileURL(page).href, '--flow', flow,
          '--preset', 'draft', '--viewport-width', '640', '--viewport-height', '480', '--post-roll', '0', '--out', join(directory, 'video.mp4'), ...extra],
        { timeout: 15_000 })
        return { code: 0, ...result }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    }
    await check({ run, flow, directory, runDirectory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('CLI reports the locator error, flow location, recording time and actual saved artifacts on stderr', { timeout: 30_000 }, async () => {
  const source = `export default async ({ page }) => {
  await page.getByRole('status', { name: 'Saved' }).waitFor({ timeout: 200 })
}`
  await withFixture(source, async ({ run, flow, runDirectory }) => {
    const result = await run('--run-dir', runDirectory)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^traceframe: \[FLOW_FAILED\] locator.waitFor: Timeout 200ms exceeded/)
    assert.match(result.stderr, /Call log:[\s\S]*getByRole\('status'/)
    assert.ok(result.stderr.includes(`  Flow: ${flow}:2:`))
    assert.match(result.stderr, /  Recording time: \d+\.\d{2} s\n/)
    for (const [label, filename] of [['Capture', 'capture.webm'], ['Screenshot', 'failure.png']]) {
      const path = join(runDirectory, filename)
      assert.ok(result.stderr.includes(`  ${label}: ${path}\n`))
      assert.ok((await stat(path)).size > 0)
    }
    assert.doesNotMatch(result.stderr, /node_modules|src\/capture\.mjs|src\/record\.mjs/)
  })
})

test('CLI still reports flow context without --run-dir and does not claim saved artifacts', { timeout: 30_000 }, async () => {
  await withFixture("export default () => { throw new Error('flow problem') }", async ({ run, flow, directory }) => {
    const result = await run()
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^traceframe: \[FLOW_FAILED\] flow problem/)
    assert.ok(result.stderr.includes(`  Flow: ${flow}:1:`))
    assert.match(result.stderr, /Recording time:/)
    assert.doesNotMatch(result.stderr, /Capture:|Screenshot:|capture\.webm|failure\.png/)
    assert.deepEqual((await readdir(directory)).sort(), ['flow.mjs', 'page.html'])
  })
})

test('CLI Ctrl-C keeps exit 130, interruption messages and partial capture without a failure screenshot', { timeout: 30_000 }, async () => {
  const source = `export default async ({ wait }) => {
  await wait(0.2)
  process.kill(process.pid, 'SIGINT')
  await new Promise(() => {})
}`
  await withFixture(source, async ({ run, runDirectory }) => {
    const result = await run('--run-dir', runDirectory)
    assert.equal(result.code, 130)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Stopping and cleaning up/)
    assert.match(result.stderr, /Recording was interrupted/)
    assert.doesNotMatch(result.stderr, /FLOW_FAILED|Recording time:|Screenshot:/)
    assert.deepEqual(await readdir(runDirectory), ['capture.webm'])
    await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', join(runDirectory, 'capture.webm'), '-f', 'null', '-'])
  })
})

test('CLI success remains a single JSON summary with empty stderr', { timeout: 30_000 }, async () => {
  await withFixture('export default async ({ wait }) => { await wait(0.1) }', async ({ run, directory }) => {
    const result = await run()
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim().split('\n').length, 1)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.output, join(directory, 'video.mp4'))
    assert.equal(summary.width, 640)
    assert.equal(summary.height, 480)
    assert.equal(summary.fps, 30)
    assert.equal(summary.moveCount, 0)
    assert.equal(summary.clickCount, 0)
    assert.equal(summary.diagnostics, undefined)
    assert.equal(summary.runDirectory, undefined)
  })
})
