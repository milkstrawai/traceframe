import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { filterComplexFileOption, parseFfmpegMajor, probeAudio, runCommand } from '../src/ffmpeg.mjs'

const banner = (version, libavutil) => `ffmpeg version ${version} Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 14\nlibavutil      ${libavutil} / ${libavutil}\n`

test('reads the major version from the ffmpeg banner', () => {
  assert.equal(parseFfmpegMajor(banner('9.0.1', '61.  1.101')), 9)
  assert.equal(parseFfmpegMajor(banner('n7.1', '59. 39.100')), 7)
  assert.equal(parseFfmpegMajor(banner('6.1.1-3ubuntu5', '58. 29.100')), 6)
  assert.equal(parseFfmpegMajor(banner('7.1-full_build-www.gyan.dev', '59. 39.100')), 7)
  assert.equal(parseFfmpegMajor(banner('4.4.2-0ubuntu0.22.04.1', '56. 70.100')), 4)
})

test('reads snapshot builds from the libavutil version', () => {
  assert.equal(parseFfmpegMajor(banner('N-121000-g0123abcd-20250901', '60.  3.100')), 8)
  assert.equal(parseFfmpegMajor(banner('git-2023-06-07-abcdef1', '58. 12.100')), 6)
  assert.equal(parseFfmpegMajor(banner('2025-01-01-git-abc1234-full_build-www.gyan.dev', '59. 54.100')), 7)
  assert.equal(parseFfmpegMajor('ffmpeg version custom\n'), undefined)
})

test('selects the filter-file option supported by the FFmpeg major version', () => {
  assert.equal(filterComplexFileOption(5), '-filter_complex_script')
  assert.equal(filterComplexFileOption(6), '-filter_complex_script')
  assert.equal(filterComplexFileOption(7), '-/filter_complex')
  assert.equal(filterComplexFileOption(9), '-/filter_complex')
})

test('explains how to install FFmpeg when the command is missing', async () => {
  await assert.rejects(runCommand('traceframe-missing-ffmpeg', ['-version']), {
    code: 'FFMPEG_MISSING',
    message: /traceframe-missing-ffmpeg was not found\. Install FFmpeg 5 or newer/,
  })
})

test('rejects FIFO audio before ffprobe can wait for a writer', { timeout: 10_000, skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-audio-fifo-'))
  try {
    const input = join(directory, 'audio.pipe')
    const signal = AbortSignal.timeout(2_000)
    await runCommand('mkfifo', [input], { signal })
    await assert.rejects(probeAudio(input, signal), {
      code: 'AUDIO_INVALID',
      message: /not a regular file/,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('waits for an aborted command to exit before rejecting', { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-command-exit-'))
  try {
    const ready = join(directory, 'ready'), exited = join(directory, 'exited')
    const controller = new AbortController()
    const slowToExit = "const fs = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.argv[2], ''); process.exit() }, 300)); fs.writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)"
    const rejected = assert.rejects(runCommand(process.execPath, ['-e', slowToExit, ready, exited], { signal: controller.signal }))
    while (!existsSync(ready)) await delay(10, undefined, { signal: t.signal })
    controller.abort()
    await rejected
    assert.ok(existsSync(exited), 'rejected before the command exited')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows cancellation stops a launcher and its child before rejecting', { skip: process.platform !== 'win32', timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-command-'))
  const pidFile = join(directory, 'child.pid')
  const controller = new AbortController()
  const worker = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"
  const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
  const rejected = assert.rejects(runCommand(process.execPath, ['-e', launcher, pidFile], { signal: controller.signal }), { code: 'COMMAND_FAILED' })
  let childPid
  try {
    while (!childPid) {
      childPid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
      if (!childPid) await delay(20, undefined, { signal: t.signal })
    }
    controller.abort()
    await rejected
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
  } finally {
    controller.abort()
    await rejected.catch(() => {})
    if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch {} }
    await rm(directory, { recursive: true, force: true })
  }
})
