import { constants, rmSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TraceframeError } from '../errors.mjs'
import { deadline, startProcess } from './process.mjs'

export const INSTALL_HELP = 'Native capture needs Linux, full Chromium, Xvfb, a C compiler, and X11/Xext development libraries. See the README native Linux capture setup.'

export async function buildGrabber(signal) {
  signal?.throwIfAborted()
  const source = join(import.meta.dirname, 'grab.c')
  const flags = ['-O2', '-std=c11', '-Wall', '-Wextra', source, '-lX11', '-lXext']
  const hash = createHash('sha256').update(await readFile(source)).update(JSON.stringify(flags.slice(0, 4))).digest('hex').slice(0, 20)
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'traceframe', 'native', `${process.arch}-${hash}`)
  const binary = join(cache, 'grab')
  try {
    await access(binary, constants.X_OK)
    return binary
  } catch {}
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(cache, 'build-'))
  const compiler = startProcess('cc', [...flags, '-o', join(temporary, 'grab')], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  const kill = () => { if (compiler.child.pid) { try { process.kill(-compiler.child.pid, 'SIGKILL') } catch {} } }
  const killOnExit = () => {
    kill()
    try { rmSync(temporary, { recursive: true, force: true }) } catch {}
  }
  process.once('exit', killOnExit)
  const listener = signal && addAbortListener(signal, kill)
  try {
    const result = await deadline(compiler.done, 30_000, new Error('Native capture compilation timed out.'))
    signal?.throwIfAborted()
    if (result.code !== 0) throw result.error ?? new Error(compiler.stderr())
    await rename(join(temporary, 'grab'), binary)
    return binary
  } catch (cause) {
    kill()
    await compiler.done
    signal?.throwIfAborted()
    throw new TraceframeError(`Could not build the native capture helper. ${INSTALL_HELP}\n${cause.message}`, { code: 'NATIVE_UNAVAILABLE', cause })
  } finally {
    listener?.[Symbol.dispose]()
    try { await rm(temporary, { recursive: true, force: true }) }
    finally { process.removeListener('exit', killOnExit) }
  }
}

// A per-session wildcard Xauthority entry: the display number is allocated by Xvfb.
export function createAuthority() {
  const fields = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from('MIT-MAGIC-COOKIE-1'), randomBytes(16)]
  return Buffer.concat([Buffer.from([255, 255]), ...fields.flatMap((field) => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(field.length)
    return [length, field]
  })])
}
