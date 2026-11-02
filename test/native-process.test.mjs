import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { deadline, describeExit, startProcess, stopProcess } from '../src/native/process.mjs'
import { buildGrabber } from '../src/native/setup.mjs'
import { createNativeSession } from '../src/native/capture.mjs'

async function compilerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-compiler-test-'))
  const bin = join(directory, 'bin')
  const allocation = join(directory, 'compiler.json')
  const wrapper = join(directory, 'compiler.mjs')
  const previous = { PATH: process.env.PATH, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(bin)
  await writeFile(wrapper, `import { spawn } from 'node:child_process'
import { writeFileSync, renameSync } from 'node:fs'
const output = process.argv[process.argv.indexOf('-o') + 1]
writeFileSync(output, 'incomplete executable', { mode: 0o700 })
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(`${allocation}.tmp`)}, JSON.stringify({ compiler: process.pid, child: child.pid, output }))
  renameSync(${JSON.stringify(`${allocation}.tmp`)}, ${JSON.stringify(allocation)})
})
`)
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  await writeFile(join(bin, 'cc'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} "$@"\n`, { mode: 0o700 })
  // Neither test needs a real compiler, Xvfb, or browser executable on PATH.
  process.env.PATH = bin
  process.env.XDG_CACHE_HOME = join(directory, 'cache')
  return {
    async started() {
      const readyBy = performance.now() + 5_000
      while (performance.now() < readyBy) {
        const owned = await readFile(allocation, 'utf8').then(JSON.parse).catch((error) => { if (error.code !== 'ENOENT') throw error })
        if (owned) return owned
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('The synthetic compiler did not start.')
    },
  }
}

async function assertTerminated(pid) {
  const exitedBy = performance.now() + 1_000
  do {
    // A process reaped after opening stat can report ESRCH instead of ENOENT.
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error })
    // The exiting parent cannot reap its child; the host's init may still be doing so.
    if (!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (performance.now() < exitedBy)
  assert.fail(`Compiler process ${pid} survived cleanup.`)
}

test('a missing native dependency settles without an unhandled spawn error', async () => {
  const process = startProcess('traceframe-missing-native-dependency', [])
  assert.equal((await process.done).error.code, 'ENOENT')
  await stopProcess(process)
})

test('native exit descriptions preserve empty-stderr exit codes and signals', async () => {
  for (const [source, expected] of [
    ['process.exit(23)', 'exit code 23'],
    ["process.kill(process.pid, 'SIGKILL')", 'signal SIGKILL'],
    ['process.exit(0)', 'exit code 0'],
  ]) {
    const child = startProcess(process.execPath, ['-e', source])
    assert.equal(describeExit(await child.done), expected)
    assert.equal(child.stderr(), '')
  }
})

test('failed native startup releases its temporary signal handlers', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const before = signals.map((name) => process.listeners(name))
  await assert.rejects(createNativeSession({ browser: '/traceframe-missing-browser' }, undefined, { handleSignals: true }), { code: 'NATIVE_UNAVAILABLE' })
  assert.deepEqual(signals.map((name) => process.listeners(name)), before)
})

test('an already-aborted native wait still handles a later task failure', async () => {
  const controller = new AbortController()
  const reason = new Error('Synthetic startup interruption')
  const task = Promise.withResolvers()
  controller.abort(reason)
  await assert.rejects(deadline(task.promise, 10_000, new Error('Startup timed out.'), controller.signal), (error) => error === reason)
  task.reject(new Error('Synthetic late task failure'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('native shutdown kills and reaps a stopped child instead of hanging', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const child = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'])
  try {
    await deadline(new Promise((resolve) => child.child.stdout.once('data', resolve)), 5_000, new Error('The child did not start.'))
    child.child.kill('SIGSTOP')
    const result = await stopProcess(child, 50)
    assert.equal(result.forced, true)
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(describeExit(result), 'signal SIGKILL, forced termination')
    assert.throws(() => process.kill(child.child.pid, 0), { code: 'ESRCH' })
  } finally {
    await stopProcess(child, 0)
  }
})

test('default native startup handles termination while compiling', { skip: process.platform !== 'linux', timeout: 20_000 }, async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    await t.test(signal, async (t) => {
      const fixture = await compilerFixture(t)
      const caller = startProcess(process.execPath, ['--input-type=module', '-e', `
        import { createNativeSession } from ${JSON.stringify(new URL('../src/native/capture.mjs', import.meta.url).href)}
        await createNativeSession({ browser: process.execPath }, undefined, { handleSignals: true })
      `], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let owned
      try {
        owned = await fixture.started()
        process.kill(owned.child, 0)
        process.kill(-caller.child.pid, signal)
        const result = await deadline(caller.done, 2_000, new Error('Startup termination did not settle.'))
        assert.equal(result.code, code, caller.stderr())
        await assertTerminated(owned.compiler)
        await assertTerminated(owned.child)
        await assert.rejects(stat(dirname(owned.output)), { code: 'ENOENT' })
        assert.deepEqual(await readdir(dirname(dirname(owned.output))), [])
      } finally {
        if (owned) {
          try { process.kill(-owned.compiler, 'SIGKILL') } catch {}
          try { process.kill(owned.child, 'SIGKILL') } catch {}
        }
        await stopProcess(caller, 0)
      }
    })
  }
})

test('cancelling helper compilation kills its process group and removes the incomplete build', { skip: process.platform !== 'linux', timeout: 15_000 }, async (t) => {
  const fixture = await compilerFixture(t)
  const controller = new AbortController()
  const reason = new Error('Synthetic compiler interruption')
  const building = buildGrabber(controller.signal)
  building.catch(() => {})
  let owned
  try {
    owned = await fixture.started()
    process.kill(owned.child, 0)
    assert.ok((await stat(owned.output)).size > 0)
    controller.abort(reason)
    await assert.rejects(deadline(building, 2_000, new Error('Compiler cancellation did not settle.')), (error) => error === reason)
    assert.throws(() => process.kill(owned.compiler, 0), { code: 'ESRCH' })
    await assertTerminated(owned.child)
    await assert.rejects(stat(dirname(owned.output)), { code: 'ENOENT' })
    assert.deepEqual(await readdir(dirname(dirname(owned.output))), [])
  } finally {
    controller.abort(reason)
    if (owned) {
      try { process.kill(-owned.compiler, 'SIGKILL') } catch {}
      try { process.kill(owned.child, 'SIGKILL') } catch {}
    }
    await building.catch(() => {})
  }
})

test('forced exit during helper compilation removes only its own staging directory', { skip: process.platform !== 'linux', timeout: 15_000 }, async (t) => {
  const fixture = await compilerFixture(t)
  const caller = startProcess(process.execPath, ['--input-type=module', '-e', `
    import { buildGrabber } from ${JSON.stringify(new URL('../src/native/setup.mjs', import.meta.url).href)}
    process.on('message', () => process.exit(130))
    await buildGrabber()
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let owned
  try {
    owned = await fixture.started()
    process.kill(owned.compiler, 0)
    process.kill(owned.child, 0)
    assert.ok((await stat(owned.output)).size > 0)
    const cache = dirname(dirname(owned.output))
    const neighboringBuild = join(cache, 'build-neighbor')
    await mkdir(neighboringBuild)
    await writeFile(join(neighboringBuild, 'keep'), 'another compilation')
    caller.child.send('exit')
    const result = await deadline(caller.done, 2_000, new Error('Forced exit did not settle.'))
    assert.equal(result.code, 130, caller.stderr())
    await assertTerminated(owned.compiler)
    await assertTerminated(owned.child)
    await assert.rejects(stat(dirname(owned.output)), { code: 'ENOENT' })
    assert.deepEqual(await readdir(cache), ['build-neighbor'])
    assert.equal(await readFile(join(neighboringBuild, 'keep'), 'utf8'), 'another compilation')
  } finally {
    if (caller.child.connected) caller.child.send('exit', () => {})
    if (owned) {
      try { process.kill(-owned.compiler, 'SIGKILL') } catch {}
      try { process.kill(owned.child, 'SIGKILL') } catch {}
    }
    await deadline(caller.done, 1_000, new Error('Test caller did not exit.')).catch(() => stopProcess(caller, 0))
  }
})
