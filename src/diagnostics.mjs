import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { TraceframeError } from './errors.mjs'

// Only report the supplied flow's locations, never the rest of a stack or error object.
export async function addDiagnostics(error, { flow, ...details }) {
  if (!(error instanceof Error)) return error
  try {
    const paths = new Set([flow, await realpath(flow).catch(() => flow)])
    const names = [...paths].flatMap((path) => [path, pathToFileURL(path).href])
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const location = new RegExp(`^\\s+at (?:async )?(?:.+ \\()?(${escaped.join('|')}):(\\d+):(\\d+)\\)?$`)
    const flowLocations = []
    const seenErrors = new Set()
    const seenLocations = new Set()
    for (let current = error; current instanceof Error && !seenErrors.has(current); current = current.cause) {
      seenErrors.add(current)
      for (const frame of String(current.stack ?? '').split('\n')) {
        const match = frame.match(location)
        if (!match || seenLocations.has(`${match[2]}:${match[3]}`)) continue
        seenLocations.add(`${match[2]}:${match[3]}`)
        flowLocations.push({ file: flow, line: Number(match[2]), column: Number(match[3]) })
      }
    }
    error.diagnostics = { flowLocations, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) }
  } catch {
    // A frozen error or an unavailable stack must not replace the original failure.
  }
  return error
}

export async function retainedFile(path) {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() && info.size > 0 ? path : undefined
}

export function formatFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof TraceframeError && error.code ? `[${error.code}] ` : ''
  const lines = [`traceframe: ${code}${message.trimEnd()}`]
  const diagnostics = error?.diagnostics
  for (const { file, line, column } of diagnostics?.flowLocations ?? []) {
    lines.push(`  Flow: ${file}:${line}:${column}`)
  }
  if (Number.isFinite(diagnostics?.recordingTime)) lines.push(`  Recording time: ${diagnostics.recordingTime.toFixed(2)} s`)
  if (diagnostics?.capturePath) lines.push(`  Capture: ${diagnostics.capturePath}`)
  if (diagnostics?.screenshotPath) lines.push(`  Screenshot: ${diagnostics.screenshotPath}`)
  return `${lines.join('\n')}\n`
}
