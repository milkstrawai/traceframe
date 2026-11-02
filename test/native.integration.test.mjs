import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { createConfig } from '../src/config.mjs'
import { probeFfmpeg } from '../src/ffmpeg.mjs'
import { createNativeSession } from '../src/native/capture.mjs'

const run = promisify(execFile)
const enabled = process.env.TRACEFRAME_TEST_NATIVE === '1' && process.platform === 'linux'
const native = (name, fn) => test(name, { skip: !enabled, timeout: 90_000 }, fn)
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-native-test-'))
  const temporary = join(directory, 'tmp')
  await mkdir(temporary)
  const previousTemp = process.env.TMPDIR
  process.env.TMPDIR = temporary
  t.after(async () => {
    if (previousTemp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTemp
    await rm(directory, { recursive: true, force: true })
  })
  const flow = join(directory, 'flow.mjs')
  await writeFile(flow, `let action, setup
export let initialPointer
export function configure(run, ready, pointer) { action = run; setup = ready; initialPointer = pointer }
export function ready(api) { return setup?.(api) }
export default function(api) { return action(api) }
`)
  const { configure } = await import(pathToFileURL(flow).href)
  const html = join(directory, 'page.html')
  await writeFile(html, '<button onclick="this.textContent=\'Saved\'">Save</button>')
  const options = { url: pathToFileURL(html).href, flow, capture: 'native', preset: 'draft', viewportWidth: 640, viewportHeight: 480, postRoll: 0.2, output: join(directory, 'video.mp4') }
  return { directory, temporary, configure, options }
}

async function ownedProcesses(page) {
  const cdp = await page.context().browser().newBrowserCDPSession()
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    const browser = processInfo.find((process) => process.type === 'browser').id
    // Chromium can rewrite /proc/cmdline as one space-delimited process title.
    const command = await readFile(`/proc/${browser}/cmdline`, 'utf8')
    const display = /(?:^|[\0 ])--display=(:\d+)(?:[\0 ]|$)/.exec(command)[1]
    // New Xvfb builds need not create .X*-lock files. Match the listening socket
    // to a direct child instead, without depending on library test hooks.
    const socketPath = `/tmp/.X11-unix/X${display.slice(1)}`
    const sockets = new Set((await readFile('/proc/net/unix', 'utf8')).trim().split('\n').filter((line) => line.endsWith(socketPath)).map((line) => line.trim().split(/\s+/)[6]))
    const rows = (await run('ps', ['-eo', 'pid=,ppid=,args='])).stdout.trim().split('\n')
    for (const row of rows) {
      const [, pid, parent, args] = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (+parent !== process.pid || !args.includes('-displayfd')) continue
      const files = await readdir(`/proc/${pid}/fd`)
      const links = await Promise.all(files.map((file) => readlink(`/proc/${pid}/fd/${file}`).catch(() => '')))
      if (!links.some((link) => sockets.has(/^socket:\[(\d+)\]$/.exec(link)?.[1]))) continue
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
      return { browser, xvfb: +pid, display, authority: argv[argv.indexOf('-auth') + 1] }
    }
    throw new Error('Could not identify the private Xvfb process.')
  } finally { await cdp.detach() }
}

async function assertClean(temporary, owned, extraPids = []) {
  assert.deepEqual(await readdir(temporary), [])
  for (const { authority } of owned) await assert.rejects(stat(dirname(authority)), { code: 'ENOENT' })
  for (const pid of [...owned.flatMap(({ browser, xvfb }) => [browser, xvfb]), ...extraPids]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

native('final native verification retries navigation context loss without accepting invalid geometry', async (t) => {
  const { directory, temporary, options } = await fixture(t)
  const config = createConfig(options)
  const signal = new AbortController().signal
  const session = await createNativeSession(config, signal, { ...await probeFfmpeg(), handleSignals: false })
  let owned
  try {
    const page = await session.browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale })
    await page.goto(options.url)
    owned = await ownedProcesses(page)
    await session.start(page, join(directory, 'capture.mkv'), signal)
    const evaluate = page.evaluate.bind(page)
    for (const [message, expectedReads] of [['Synthetic verification failure', 1], ['Execution context was destroyed', 2]]) {
      const reason = new Error(message)
      let reads = 0
      page.evaluate = async () => { reads++; throw reason }
      try {
        await assert.rejects(session.verify(), (error) => error.code === 'NATIVE_CAPTURE_FAILED' && error.cause === reason)
        assert.equal(reads, expectedReads)
      } finally { page.evaluate = evaluate }
    }
    const next = join(directory, 'next.html')
    await writeFile(next, '<h1>Order summary</h1>')
    for (const [message, resize] of [
      ['Execution context was destroyed, most likely because of a navigation', false],
      ['Cannot find context with specified id', false],
      ['Execution context was destroyed, most likely because of a navigation', true],
    ]) {
      // Invoke verify directly so a periodic poll cannot consume the injected error.
      page.evaluate = async () => {
        page.evaluate = evaluate
        await page.goto(pathToFileURL(next).href)
        if (resize) await page.setViewportSize({ width: 600, height: 480 })
        throw new Error(message)
      }
      if (resize) await assert.rejects(session.verify(), { code: 'NATIVE_CAPTURE_FAILED', message: /geometry/ })
      else await session.verify()
    }
    await session.stop()
  } finally { await session.close() }
  await assertClean(temporary, [owned])
})
