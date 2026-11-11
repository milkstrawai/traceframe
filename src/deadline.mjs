import { addAbortListener } from 'node:events'

// Settles with the task, or rejects at the deadline or on abort, even if the task ignores its signal.
export async function withDeadline(task, milliseconds, error, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(error), milliseconds)
  const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    deadline.throwIfAborted()
    return await raceAbort(task(deadline), deadline)
  } finally {
    clearTimeout(timer)
  }
}

export async function raceAbort(promise, signal) {
  const aborted = Promise.withResolvers()
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason))
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    listener[Symbol.dispose]()
  }
}
