import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { addDiagnostics, formatFailure } from '../src/diagnostics.mjs'
import { TraceframeError } from '../src/errors.mjs'

test('extracts only exact flow locations across causes, without exposing other error fields', async () => {
  const flow = join(tmpdir(), 'flow (review) #1.mjs')
  const cause = new Error('locator failed')
  cause.stack = `Error: locator failed
    at missingBadge (${pathToFileURL(flow).href}:8:12)
    at async ${flow}:12:3
    at helper (${flow}.other:1:2)
    at other (/unrelated/private-helper.mjs:3:4)
not a frame ${flow}:99:99`
  cause.privateState = { cookie: 'synthetic-do-not-print' }
  const error = new TraceframeError(cause.message, { code: 'FLOW_FAILED', cause })
  error.stack = `TraceframeError: locator failed\n    at wrapper (/internal/capture.mjs:1:2)\n    at missingBadge (${flow}:8:12)`
  cause.cause = error

  assert.equal(await addDiagnostics(error, { flow, recordingTime: 1.25, capturePath: undefined }), error)
  assert.deepEqual(error.diagnostics, {
    flowLocations: [{ file: flow, line: 8, column: 12 }, { file: flow, line: 12, column: 3 }],
    recordingTime: 1.25,
  })
  assert.equal(error.cause, cause)
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /private|synthetic|internal/)
})

test('matches canonical stack paths when the flow was loaded through a symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-locations-'))
  try {
    const path = join(directory, 'actual.mjs')
    const alias = join(directory, 'alias.mjs')
    await writeFile(path, '')
    await symlink(path, alias)
    const error = new Error('failed')
    error.stack = `Error: failed\n    at default (${pathToFileURL(path).href}:4:5)`
    await addDiagnostics(error, { flow: alias })
    assert.deepEqual(error.diagnostics.flowLocations, [{ file: alias, line: 4, column: 5 }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unavailable stacks and frozen errors do not replace the original failure', async () => {
  const flow = join(tmpdir(), 'flow.mjs')
  const error = new Error('failed')
  error.stack = undefined
  await addDiagnostics(error, { flow })
  assert.deepEqual(error.diagnostics.flowLocations, [])
  const frozen = Object.freeze(new Error('frozen'))
  assert.equal(await addDiagnostics(frozen, { flow }), frozen)
  assert.equal(await addDiagnostics(null, { flow }), null)
})

test('formats only the original message, Traceframe code and selected diagnostics', () => {
  const error = new TraceframeError('locator timed out\nCall log:\n  - waiting for Saved\n', {
    code: 'FLOW_FAILED', cause: new Error('synthetic private cause detail'),
  })
  error.diagnostics = {
    flowLocations: [{ file: '/example/flow.mjs', line: 4, column: 9 }],
    recordingTime: 12.345,
    capturePath: '/example/run/capture.webm',
    screenshotPath: '/example/run/failure.png',
    extra: 'synthetic private extra detail',
  }
  error.privateState = 'synthetic private state'
  assert.equal(formatFailure(error), `traceframe: [FLOW_FAILED] locator timed out
Call log:
  - waiting for Saved
  Flow: /example/flow.mjs:4:9
  Recording time: 12.35 s
  Capture: /example/run/capture.webm
  Screenshot: /example/run/failure.png
`)
})

test('omits unavailable diagnostics and keeps ordinary usage errors concise', () => {
  assert.equal(formatFailure(new Error('Unknown option')), 'traceframe: Unknown option\n')
  assert.equal(formatFailure('plain failure'), 'traceframe: plain failure\n')
  const error = new TraceframeError('not ready', { code: 'READY_FAILED' })
  error.diagnostics = { flowLocations: [] }
  assert.equal(formatFailure(error), 'traceframe: [READY_FAILED] not ready\n')
})

test('callback errors retain timing and artifacts without inventing source locations', async () => {
  const error = new Error('callback failed')
  await addDiagnostics(error, { recordingTime: 0.4, capturePath: '/example/capture.webm' })
  assert.deepEqual(error.diagnostics, { flowLocations: [], recordingTime: 0.4, capturePath: '/example/capture.webm' })
})
