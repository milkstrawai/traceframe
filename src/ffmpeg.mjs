import { execFile } from 'node:child_process'
import { addAbortListener } from 'node:events'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import { TraceframeError } from './errors.mjs'

const execFileAsync = promisify(execFile)

export async function probeFfmpeg({ audio = false } = {}) {
  const version = await runCommand('ffmpeg', ['-version'])
  const major = parseFfmpegMajor(version.stdout)
  if (!(major >= 5)) {
    throw new TraceframeError(`FFmpeg 5 or newer is required. Found: ${version.stdout.split('\n')[0].trim()}`, { code: 'FFMPEG_UNSUPPORTED' })
  }
  const codecs = await runCommand('ffmpeg', ['-hide_banner', '-encoders'])
  if (!codecs.stdout.includes('libx264')) {
    throw new TraceframeError('System FFmpeg does not provide the libx264 encoder.', { code: 'FFMPEG_UNSUPPORTED' })
  }
  if (audio && !/^\s*A\S*\s+aac\s/m.test(codecs.stdout)) {
    throw new TraceframeError('System FFmpeg does not provide the AAC encoder required for audio.', { code: 'FFMPEG_UNSUPPORTED' })
  }
  await runCommand('ffprobe', ['-version'])
  return {
    filterComplexFileOption: filterComplexFileOption(major),
    // FFmpeg 7's pass mode cuts off padded main-video frames at the original EOF.
    overlayEofAction: major === 7 ? 'repeat' : 'pass',
  }
}

export async function probeAudio(path, signal) {
  try {
    if (!(await stat(path)).isFile()) throw new Error('The input is not a regular file.')
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'json', path], { signal })
    const { streams } = JSON.parse(stdout)
    if (!streams.length) throw new Error('The file has no audio stream.')
  } catch (cause) {
    signal?.throwIfAborted()
    throw new TraceframeError(`Could not read audio from ${path}: ${cause.message}`, { code: 'AUDIO_INVALID', cause })
  }
}

export async function probeVideoDuration(path, signal) {
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', path], { signal })
  return Number(stdout)
}

export async function runCommand(command, args, options = {}) {
  const windowsSignal = process.platform === 'win32' ? options.signal : undefined
  windowsSignal?.throwIfAborted()
  const run = execFileAsync(command, args, windowsSignal ? { ...options, signal: undefined } : options)
  const closed = new Promise((resolve) => run.child.once('close', resolve))
  let termination
  const abort = windowsSignal && addAbortListener(windowsSignal, () => {
    // Chocolatey shims launch the real encoder as a child. Stop both before
    // removing files, which Windows keeps locked while the encoder is alive.
    if (run.child.pid && run.child.exitCode === null && run.child.signalCode === null) {
      termination = execFileAsync('taskkill', ['/pid', String(run.child.pid), '/t', '/f'])
        .catch(() => run.child.kill())
    }
  })
  try {
    return await run
  } catch (error) {
    // An abort rejects at once, but the process may take a moment to exit. Wait so cleanup does not race it.
    if (options.signal?.aborted) await closed
    if (error.code === 'ENOENT') {
      throw new TraceframeError(`${command} was not found. Install FFmpeg 5 or newer with libx264, and make sure ffmpeg and ffprobe are on your PATH.`, { code: 'FFMPEG_MISSING' })
    }
    const rawDetail = error.stderr?.trim() || error.stdout?.trim() || error.message
    const detail = rawDetail.length > 2_000 ? `${rawDetail.slice(0, 1_900)}\n… output truncated` : rawDetail
    throw new TraceframeError(`${command} failed: ${detail}`, { code: 'COMMAND_FAILED', cause: error })
  } finally {
    abort?.[Symbol.dispose]()
    await termination
  }
}

export function parseFfmpegMajor(output) {
  const release = output.match(/ffmpeg version [nN]?(\d+)\./)
  if (release) return Number(release[1])
  // Snapshot builds print no release number. libavutil 57 shipped with FFmpeg 5, 58 with 6, 59 with 7, and so on.
  const libavutil = output.match(/libavutil\s+(\d+)\./)
  return libavutil ? Number(libavutil[1]) - 52 : undefined
}

export function filterComplexFileOption(major) {
  return major >= 7 ? '-/filter_complex' : '-filter_complex_script'
}
