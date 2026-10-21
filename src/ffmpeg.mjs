import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { TraceframeError } from './errors.mjs'

const execFileAsync = promisify(execFile)

export async function probeFfmpeg() {
  const version = await runCommand('ffmpeg', ['-version'])
  const major = parseFfmpegMajor(version.stdout)
  if (!(major >= 5)) {
    throw new TraceframeError(`FFmpeg 5 or newer is required. Found: ${version.stdout.split('\n')[0].trim()}`, { code: 'FFMPEG_UNSUPPORTED' })
  }
  const codecs = await runCommand('ffmpeg', ['-hide_banner', '-encoders'])
  if (!codecs.stdout.includes('libx264')) {
    throw new TraceframeError('System FFmpeg does not provide the libx264 encoder.', { code: 'FFMPEG_UNSUPPORTED' })
  }
  await runCommand('ffprobe', ['-version'])
  return { filterComplexFileOption: filterComplexFileOption(major) }
}

export async function probeDuration(path, signal) {
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { signal })
  return Number(stdout)
}

export async function runCommand(command, args, options = {}) {
  const run = execFileAsync(command, args, options)
  const closed = new Promise((resolve) => run.child.once('close', resolve))
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
