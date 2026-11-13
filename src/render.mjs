import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { runFiles } from './config.mjs'
import { easeOutCubicExpression } from './easing.mjs'
import { probeVideoDuration, runCommand } from './ffmpeg.mjs'
import { TraceframeError } from './errors.mjs'

const ASSETS = join(import.meta.dirname, 'assets')
// The arrow tip in cursor.svg.
const CURSOR_HOTSPOT = { x: 6.6, y: 1.6 }
const CLICK = { duration: 0.24, scaleStart: 0.7, scaleEnd: 1.25 }

export async function renderVideo({ rawPath, trace, directory, config, ffmpeg, signal, audio }) {
  const { fps } = config.video
  const outputDuration = Math.max(1 / fps, trace.end + config.postRoll, ...trace.clicks.map((click) => click.at + CLICK.duration))
  if (audio && audio.offset >= outputDuration) {
    throw new TraceframeError(`Audio offset ${audio.offset} seconds starts at or after the video's end (${number(outputDuration)} seconds). Reduce its offset.`, { code: 'AUDIO_OUTSIDE_VIDEO' })
  }
  const filterPath = runFiles(directory).filter
  await writeFile(filterPath, buildFilterScript({ trace, scale: config.scale, fps, audio, overlayEofAction: ffmpeg.overlayEofAction }))
  const outputTemp = join(dirname(config.output), `.traceframe-${randomUUID()}.tmp.mp4`)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', rawPath,
    '-loop', '1', '-framerate', String(fps), '-i', join(ASSETS, `cursor-${config.scale}x.png`),
  ]
  if (trace.clicks.length) args.push('-loop', '1', '-framerate', String(fps), '-t', String(CLICK.duration + 1 / fps), '-i', join(ASSETS, `click-pulse-${config.scale}x.png`))
  if (audio) args.push('-i', audio.path)
  args.push(
    ffmpeg.filterComplexFileOption, filterPath,
    '-map', '[final]',
  )
  if (audio) args.push('-map', '[finalAudio]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
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

// Event times are seconds from the first frame of the raw video.
export function buildFilterScript({ trace, scale, fps = 60, audio, overlayEofAction = 'pass' }) {
  const { clicks, moves } = trace
  const animatedOverlays = clicks.length > 0 || moves.length > 0
  const cadence = `tpad=stop_mode=clone:stop_duration=1,fps=${fps}`
  // Pass mode avoids waiting on looping image inputs; FFmpeg 7 needs repeat for padding.
  // yuv444 places overlays on whole pixels rather than snapping them to even pixels.
  const overlay = `eof_action=${overlayEofAction}:format=yuv444`
  // Animated overlays need every output tick, even on a static page.
  // With stationary overlays, composite before duplicating identical frames.
  // Padding also covers a sub-frame take or final rounding.
  // Chrome JPEGs are full range; normalize before compositing limited-range overlays.
  // Convert to the overlay format before duplicating frames. Converting afterward
  // can queue a full-size buffer for every repeated frame in a long static gap.
  const filters = [`[0:v]scale=out_range=tv,format=yuv420p,format=yuv444p,setpts=PTS-STARTPTS${animatedOverlays ? ',' + cadence : ''}[video0]`]
  if (clicks.length) filters.push(`[2:v]format=rgba,split=${clicks.length}${clicks.map((_, index) => `[pulse${index}]`).join('')}`)
  clicks.forEach((click, index) => filters.push(...clickFilter(click, index, scale, overlay)))

  const cursorLabels = moves.map((_, index) => `[cursor${index}]`).join('')
  // Convert the cursor once before splitting it into movement segments.
  filters.push(`[1:v]format=yuva444p,split=${moves.length + 1}${cursorLabels}[cursor${moves.length}]`)
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
  filters.push(`[cursorVideo${moves.length}]colorspace=ispace=bt470bg:iprimaries=bt709:itrc=bt709:all=bt709:format=yuv420p${animatedOverlays ? '' : ',' + cadence}[final]`)
  if (audio) {
    const input = clicks.length ? 3 : 2
    const trim = number(Math.max(0, -audio.offset))
    const delay = number(Math.max(0, audio.offset) * 1000)
    // Reset the selected stream before trimming: its first sample may start after the container's video.
    // Preserve real gaps before sample-count filters, tolerating normal recorder timestamp jitter.
    filters.push(`[${input}:a:0]asetpts=PTS-STARTPTS,aresample=async=1:min_hard_comp=0.02,atrim=start=${trim},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,apad[finalAudio]`)
  }
  return filters.join(';')
}

function clickFilter(click, index, scale, overlay) {
  const start = number(click.at)
  const end = number(start + CLICK.duration)
  const growth = `(${CLICK.scaleStart}+${CLICK.scaleEnd - CLICK.scaleStart}*clip((t-${start})/${CLICK.duration},0,1))`
  return [
    `[pulse${index}]setpts=PTS-STARTPTS+${start}/TB,scale=w='iw*${growth}':h='ih*${growth}':eval=frame,fade=t=out:st=${start}:d=${CLICK.duration}:alpha=1[click${index}]`,
    `[video${index}][click${index}]overlay=x='${number(click.point.x * scale)}-w/2':y='${number(click.point.y * scale)}-h/2':${overlay}:enable='between(t,${start},${end})'[video${index + 1}]`,
  ]
}

function number(value) {
  return Number(value.toFixed(6))
}
