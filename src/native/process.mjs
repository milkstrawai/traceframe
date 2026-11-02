import { spawn } from 'node:child_process'
import { addAbortListener } from 'node:events'

export function describeExit({ code, signal, error, forced }) {
  const status = error?.message ?? (signal ? `signal ${signal}` : `exit code ${code}`)
  return forced ? `${status}, forced termination` : status
}

export function startProcess(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let stderr = ''
  const done = new Promise((resolve) => {
    let error
    child.once('error', (cause) => { error = cause })
    child.once('close', (code, signal) => resolve({ code, signal, error }))
  })
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000) })
  return { child, done, stderr: () => stderr }
}

// Bounds the wait, not the underlying work; callers own cancellation and cleanup.
export async function deadline(promise, milliseconds, error, signal) {
  let timer, listener
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        signal?.throwIfAborted()
        timer = setTimeout(() => reject(error), milliseconds)
        if (signal) listener = addAbortListener(signal, () => reject(signal.reason))
      }),
      promise,
    ])
  } finally {
    clearTimeout(timer)
    listener?.[Symbol.dispose]()
  }
}

// Always reap the child, including a stopped process that cannot handle SIGTERM.
export async function stopProcess(process, milliseconds = 3_000) {
  process.child.kill('SIGTERM')
  try {
    return { ...await deadline(process.done, milliseconds, new Error('Process shutdown timed out.')), forced: false }
  } catch {
    process.child.kill('SIGKILL')
    return { ...await deadline(process.done, 3_000, new Error('Could not reap the native capture process.')), forced: true }
  }
}
