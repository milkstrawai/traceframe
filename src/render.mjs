import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { runFiles } from './config.mjs'
import { easeOutCubicExpression } from './easing.mjs'
import { probeVideoDuration, runCommand } from './ffmpeg.mjs'
import { TraceframeError } from './errors.mjs'

const ASSETS = join(import.meta.dirname, 'assets')
// The arrow tip in cursor.svg.
const CURSOR_HOTSPOT = { x: 6.6, y: 1.6 }
const CLICK = { duration: 0.24, scaleStart: 0.7, scaleEnd: 1.25 }
// Under the narration, audio is turned down while a line is spoken, just enough to sit 18 dB below the voice there,
// fading over 0.2 seconds on either side. Audio already that quiet is left as it is, and nothing is turned up. Lines
// less than a second apart share one dip, so the audio does not swell between them.
const DUCK = { below: 18, fade: 0.2, join: 1 }
const STEREO = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

// `audio` is the caller's { path, offset }, and `narration` the spoken track from the first frame: { path, spoken: [{ start, end }] }.
export async function renderVideo({ rawPath, trace, directory, config, ffmpeg, signal, audio, narration, captions = [] }) {
  const { fps } = config.video
  const outputDuration = Math.max(1 / fps, trace.end + config.postRoll, ...trace.clicks.map((click) => click.at + CLICK.duration))
  if (audio && audio.offset >= outputDuration) {
    throw new TraceframeError(`Audio offset ${audio.offset} seconds starts at or after the video's end (${number(outputDuration)} seconds). Reduce its offset.`, { code: 'AUDIO_OUTSIDE_VIDEO' })
  }
  const filterPath = runFiles(directory).filter
  const duck = audio && narration ? await duckUnderVoice(audio, narration, signal) : []
  const { captureGraph, script } = buildRenderFilters({ rawPath, trace, scale: config.scale, fps, audio, narration, duck, captions, overlayEofAction: ffmpeg.overlayEofAction })
  await writeFile(filterPath, script)
  const outputTemp = join(dirname(config.output), `.traceframe-${randomUUID()}.tmp.mp4`)
  const inputs = {
    capture: captureGraph ? ['-f', 'lavfi', '-i', captureGraph] : ['-i', rawPath],
    cursor: ['-loop', '1', '-framerate', String(fps), '-i', join(ASSETS, `cursor-${config.scale}x.png`)],
    pulse: ['-loop', '1', '-framerate', String(fps), '-t', String(CLICK.duration + 1 / fps), '-i', join(ASSETS, `click-pulse-${config.scale}x.png`)],
    audio: ['-i', audio?.path],
    narration: ['-i', narration?.path],
    ...Object.fromEntries(captions.map((caption, index) => [`caption${index}`, ['-loop', '1', '-framerate', String(fps), '-t', String(number(caption.end - caption.start + 1 / fps)), '-i', caption.path]])),
  }
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...Object.keys(inputIndices(trace, audio, narration, captions)).flatMap((name) => inputs[name]),
    ffmpeg.filterComplexFileOption, filterPath,
    '-map', '[final]',
  ]
  if (audio || narration) args.push('-map', '[finalAudio]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  if (captureGraph && ffmpeg.major === 5) {
    // FFmpeg 5's lavfi input loses the source's chroma sample location.
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=chroma_location', '-of', 'csv=p=0', rawPath], { signal })
    const location = stdout.trim()
    if (location && location !== 'unspecified' && location !== 'unknown') args.push('-chroma_sample_location', location)
  }
  args.push(
    '-t', String(number(outputDuration)),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-g', String(fps * 2),
    '-movflags', '+faststart', outputTemp,
  )
  try {
    await runCommand('ffmpeg', args, { signal })
    const duration = await probeVideoDuration(outputTemp, signal)
    if (!(Math.abs(duration - outputDuration) <= 1.5 / fps)) {
      throw new TraceframeError(`The rendered video is ${duration.toFixed(2)} seconds long, but the recording is ${outputDuration.toFixed(2)} seconds.`, { code: 'OUTPUT_MISMATCH' })
    }
    signal?.throwIfAborted()
    await rename(outputTemp, config.output)
    return duration
  } catch (error) {
    await rm(outputTemp, { force: true })
    throw error
  }
}

// Event times are seconds from the first frame of the raw video. Captions ({ path, start, end, x, y }) are images
// placed in video pixels, drawn over the page and under the click pulses and cursor. Under the narration, `duck` turns
// the audio down by `cut` dB from `start` to `end`: [{ start, end, cut }].
export function buildRenderFilters({ rawPath, trace, scale, fps, audio, narration, duck = [], captions = [], overlayEofAction }) {
  const { clicks, moves } = trace
  const input = inputIndices(trace, audio, narration, captions)
  const animatedOverlays = clicks.length > 0 || moves.length > 0 || captions.length > 0
  // Normalize Chrome's full-range JPEGs before duplicating frames. Padding covers sub-frame takes and final rounding.
  const normalize = 'scale=out_range=tv,format=yuv420p,format=yuv444p'
  const pad = 'tpad=stop_mode=clone:stop_duration=1'
  // Let the compositor pull one frame per tick. Expanding a long static hold inside its graph can queue
  // gigabytes of writable copies downstream. A stationary cursor can still be drawn before duplication.
  // FFmpeg 7 clears the frame rate in setpts. Pad first so a one-frame take survives resampling.
  const captureGraph = animatedOverlays
    ? `movie=filename=${quoteFilterValue(quoteFilterValue('file:' + resolve(rawPath)))},${normalize},${pad},setpts=PTS-STARTPTS,fps=${fps}`
    : undefined
  // Pass mode avoids waiting on looping image inputs; FFmpeg 7 needs repeat for padding.
  // yuv444 places overlays on whole pixels rather than snapping them to even pixels.
  const overlay = `eof_action=${overlayEofAction}:format=yuv444`
  // Captions go over the page, from [page0] to [video0], before the click pulses and cursor.
  const page = (index) => (index < captions.length ? `page${index}` : 'video0')
  const pageFilter = animatedOverlays ? 'null' : `${normalize},setpts=PTS-STARTPTS`
  const filters = [`[${input.capture}:v]${pageFilter}[${page(0)}]`]
  captions.forEach((caption, index) => {
    const start = number(caption.start)
    filters.push(
      `[${input[`caption${index}`]}:v]format=yuva444p,setpts=PTS-STARTPTS+${start}/TB[caption${index}]`,
      `[${page(index)}][caption${index}]overlay=x=${caption.x}:y=${caption.y}:${overlay}:enable='between(t,${start},${number(caption.end)})'[${page(index + 1)}]`,
    )
  })
  if (clicks.length) filters.push(`[${input.pulse}:v]format=rgba,split=${clicks.length}${clicks.map((_, index) => `[pulse${index}]`).join('')}`)
  clicks.forEach((click, index) => filters.push(...clickFilter(click, index, scale, overlay)))

  const cursorLabels = moves.map((_, index) => `[cursor${index}]`).join('')
  // Convert the cursor once before splitting it into movement segments.
  filters.push(`[${input.cursor}:v]format=yuva444p,split=${moves.length + 1}${cursorLabels}[cursor${moves.length}]`)
  const coordinate = (value, hotspot) => number(value * scale - hotspot * scale)
  const initialEnable = moves.length ? `:enable='lt(t,${number(moves[0].at)})'` : ''
  filters.push(`[video${clicks.length}][cursor0]overlay=x='${coordinate(trace.initialPointer.x, CURSOR_HOTSPOT.x)}':y='${coordinate(trace.initialPointer.y, CURSOR_HOTSPOT.y)}':${overlay}${initialEnable}[cursorVideo0]`)
  moves.forEach((move, index) => {
    const start = number(move.at)
    const end = index + 1 < moves.length ? number(moves[index + 1].at) : undefined
    // Each window excludes its end, so the frame where one move hands over to the next does not draw the cursor twice.
    const enable = end === undefined ? `gte(t,${start})` : `gte(t,${start})*lt(t,${end})`
    const eased = easeOutCubicExpression(`clip((t-${start})/${number(move.duration)},0,1)`)
    const x = `${coordinate(move.from.x, CURSOR_HOTSPOT.x)}+${number((move.to.x - move.from.x) * scale)}*${eased}`
    const y = `${coordinate(move.from.y, CURSOR_HOTSPOT.y)}+${number((move.to.y - move.from.y) * scale)}*${eased}`
    filters.push(`[cursorVideo${index}][cursor${index + 1}]overlay=x='${x}':y='${y}':${overlay}:enable='${enable}'[cursorVideo${index + 1}]`)
  })
  const cadence = animatedOverlays ? '' : `,${pad},fps=${fps}`
  filters.push(`[cursorVideo${moves.length}]colorspace=ispace=bt470bg:iprimaries=bt709:itrc=bt709:all=bt709:format=yuv420p${cadence}[final]`)
  if (audio || narration) filters.push(...audioFilters(input, audio, narration, duck))
  return { captureGraph, script: filters.join(';') }
}

// The filter graph and the movie filter each consume one level of FFmpeg quoting.
function quoteFilterValue(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// The audio at its offset and the narration from the first frame, mixed when there are both, as [finalAudio].
function audioFilters(input, audio, narration, duck) {
  if (!narration) return [`[${input.audio}:a:0]${place(audio.offset)},apad[finalAudio]`]
  if (!audio) return [`[${input.narration}:a:0]${place(0)},apad[finalAudio]`]

  // Each dip is 1 within it and 0 outside it, with a linear fade between, times the share of the audio it takes away.
  // Dips are further apart than two fades, so at most one is fading at a time.
  const dips = duck.filter(({ cut }) => cut > 0)
    .map(({ start, end, cut }) => `${number(1 - 10 ** (-cut / 20))}*clip(min(t-${number(start)},${number(end)}-t)/${DUCK.fade}+1,0,1)`)
  // The level is set once per frame, so short frames keep its fades smooth.
  const level = dips.length ? `,asetnsamples=240,volume='1-(${dips.join('+')})':eval=frame` : ''
  return [
    `[${input.audio}:a:0]${place(audio.offset)},${STEREO}${level},apad[underVoice]`,
    `[${input.narration}:a:0]${place(0)},${STEREO},apad[voice]`,
    // Both keep their level, rather than each being divided by the number of inputs.
    '[underVoice][voice]amix=inputs=2:normalize=0[finalAudio]',
  ]
}

// An audio stream placed in the video `offset` seconds in, or with its first -offset seconds cut. Its first sample may
// start after the container's video, so the stream is reset before trimming. Real gaps are kept for the sample-count
// filters after it, tolerating normal recorder timestamp jitter.
function place(offset) {
  return `asetpts=PTS-STARTPTS,aresample=async=1:min_hard_comp=0.02,atrim=start=${number(Math.max(0, -offset))},asetpts=PTS-STARTPTS,adelay=${number(Math.max(0, offset) * 1000)}:all=1`
}

// One dip for each stretch of speech, with the cut in dB that keeps the audio DUCK.below under the voice there, measured
// as each sounds in the mix.
export async function duckUnderVoice(audio, narration, signal) {
  const dips = []
  for (const { start, end } of narration.spoken) {
    const last = dips.at(-1)
    if (last && start - last.end < DUCK.join) last.end = end
    else dips.push({ start, end })
  }
  // One block past the last line, which covers its last block even when the line is shorter than a block. One at a
  // time, so a failed or cancelled measurement leaves no other still reading.
  const until = dips.at(-1).end + 0.4
  const sound = await measureLoudness(audio.path, audio.offset, until, signal)
  const voice = await measureLoudness(narration.path, 0, until, signal)
  return dips.map(({ start, end }) => {
    const voiceLevel = loudness(voice, start, end)
    const cut = voiceLevel === -Infinity ? 0 : Math.max(0, loudness(sound, start, end) - (voiceLevel - DUCK.below))
    return { start, end, cut }
  })
}

// The loudness in LUFS of the first audio stream, placed as in the mix and padded with silence to `until` seconds, as
// FFmpeg measures it for each 400 ms, every 100 ms: entry k ends (k + 1) / 10 seconds into the video.
async function measureLoudness(path, offset, until, signal) {
  const chain = `${place(offset)},apad,atrim=end=${number(until)},${STEREO},ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-`
  // The output grows by about 0.6 kB per second, past the 1 MiB default after half an hour.
  const { stdout } = await runCommand('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-af', chain, '-f', 'null', '-'], { signal, maxBuffer: Infinity })
  return [...stdout.matchAll(/lavfi\.r128\.M=(\S+)/g)].map(([, value]) => Number(value))
}

// The gated loudness (ITU-R BS.1770, as in FFmpeg's integrated loudness) of the 400 ms blocks that cover `start` to
// `end` seconds, or -Infinity when they are silent.
function loudness(blocks, start, end) {
  // Block k spans (k - 3) / 10 to (k + 1) / 10 seconds. These run from the block starting at or before `start` through
  // the one ending at or after `end`, or are just the first when it already reaches `end`. The 1e-6 keeps a time on
  // the grid that addition left a hair off, such as 0.1 + 0.2, from taking one more block.
  const first = Math.floor(start * 10 + 1e-6) + 3
  const last = Math.max(first, Math.ceil(end * 10 - 1e-6) - 1)
  // Silence reads far below -70, under the absolute gate.
  const levels = blocks.slice(first, last + 1).filter((level) => level > -70)
  if (!levels.length) return -Infinity
  const mean = (list) => 10 * Math.log10(list.reduce((sum, level) => sum + 10 ** (level / 10), 0) / list.length)
  const gate = mean(levels) - 10
  return mean(levels.filter((level) => level > gate))
}

// FFmpeg numbers its inputs in this order; the click pulse, the audio, the narration and the captions are added only
// when used.
function inputIndices(trace, audio, narration, captions) {
  const names = ['capture', 'cursor', ...(trace.clicks.length ? ['pulse'] : []), ...(audio ? ['audio'] : []), ...(narration ? ['narration'] : []), ...captions.map((_, index) => `caption${index}`)]
  return Object.fromEntries(names.map((name, index) => [name, index]))
}

function clickFilter(click, index, scale, overlay) {
  const start = number(click.at)
  const end = number(start + CLICK.duration)
  const growth = `(${CLICK.scaleStart}+${CLICK.scaleEnd - CLICK.scaleStart}*clip((t-${start})/${CLICK.duration},0,1))`
  // FFmpeg 9.1's fade requires fixed-size input. Fade the pulse before animating its size.
  return [
    `[pulse${index}]setpts=PTS-STARTPTS+${start}/TB,fade=t=out:st=${start}:d=${CLICK.duration}:alpha=1,scale=w='iw*${growth}':h='ih*${growth}':eval=frame[click${index}]`,
    `[video${index}][click${index}]overlay=x='${number(click.point.x * scale)}-w/2':y='${number(click.point.y * scale)}-h/2':${overlay}:enable='between(t,${start},${end})'[video${index + 1}]`,
  ]
}

function number(value) {
  return Number(value.toFixed(6))
}
