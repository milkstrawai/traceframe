import test from 'node:test'
import assert from 'node:assert/strict'

import { filterComplexFileOption, parseFfmpegMajor, runCommand } from '../src/ffmpeg.mjs'

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

test('waits for an aborted command to exit before rejecting', async () => {
  const controller = new AbortController()
  const slowToExit = "process.on('SIGTERM', () => setTimeout(() => process.exit(), 500)); setInterval(() => {}, 1000)"
  const running = runCommand(process.execPath, ['-e', slowToExit], { signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  const started = performance.now()
  await assert.rejects(running)
  assert.ok(performance.now() - started >= 400)
})
