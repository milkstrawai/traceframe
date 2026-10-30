import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { probeVideoDuration, runCommand } from './ffmpeg.mjs'
import { TraceframeError } from './errors.mjs'

const ASSETS = join(import.meta.dirname, 'assets')
// The arrow tip in cursor.svg.
const CURSOR_HOTSPOT = { x: 6.6, y: 1.6 }
const CLICK = { duration: 0.24, scaleStart: 0.7, scaleEnd: 1.25 }
// eof_action=pass lets the main video drive each overlay instead of waiting on the looping image inputs; without it, rendering is many times slower.
// format=yuv444 places overlays on whole pixels. The default yuv420 snaps them to even pixels, and RGB costs more for the same result.
const OVERLAY = 'eof_action=pass:format=yuv444'

export async function renderVideo({ rawPath, trace, directory, config, ffmpeg, signal, audio }) {
  const { fps } = config.video
  const outputDuration = Math.max(trace.end + config.postRoll, ...trace.clicks.map((click) => click.at + CLICK.duration))
  if (audio && audio.offset >= outputDuration) {
    throw new TraceframeError(`Audio offset ${audio.offset} seconds starts at or after the video's end (${number(outputDuration)} seconds). Reduce its offset.`, { code: 'AUDIO_OUTSIDE_VIDEO' })
  }
  const filterPath = join(directory, 'render.filter')
  await writeFile(filterPath, buildFilterScript({ trace, scale: config.scale, audio }))
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
export function buildFilterScript({ trace, scale, audio }) {
  const { clicks, moves } = trace
  // Playwright ends the raw video by the time it received the last frame, so a page that stays still can end it a little before the post-roll. The page did not change, so repeat its last frame.
  const filters = [`[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1[video0]`]
  if (clicks.length) filters.push(`[2:v]format=rgba,split=${clicks.length}${clicks.map((_, index) => `[pulse${index}]`).join('')}`)
  clicks.forEach((click, index) => filters.push(...clickFilter(click, index, scale)))

  const cursorLabels = moves.map((_, index) => `[cursor${index}]`).join('')
  filters.push(`[1:v]format=rgba,split=${moves.length + 1}${cursorLabels}[cursor${moves.length}]`)
  const coordinate = (value, hotspot) => number(value * scale - hotspot * scale)
  const initialEnable = moves.length ? `:enable='lt(t,${number(moves[0].at)})'` : ''
  filters.push(`[video${clicks.length}][cursor0]overlay=x='${coordinate(trace.initialPointer.x, CURSOR_HOTSPOT.x)}':y='${coordinate(trace.initialPointer.y, CURSOR_HOTSPOT.y)}':${OVERLAY}${initialEnable}[cursorVideo0]`)
  moves.forEach((move, index) => {
    const start = number(move.at)
    const end = index + 1 < moves.length ? number(moves[index + 1].at) : undefined
    // Each window excludes its end, so the frame where one move hands over to the next does not draw the cursor twice.
    const enable = end === undefined ? `gte(t,${start})` : `gte(t,${start})*lt(t,${end})`
    // The same curve as easeOutCubic in flow.mjs, so the drawn cursor follows the real pointer.
    const eased = `(1-pow(1-clip((t-${start})/${number(move.duration)},0,1),3))`
    const x = `${coordinate(move.from.x, CURSOR_HOTSPOT.x)}+${number((move.to.x - move.from.x) * scale)}*${eased}`
    const y = `${coordinate(move.from.y, CURSOR_HOTSPOT.y)}+${number((move.to.y - move.from.y) * scale)}*${eased}`
    filters.push(`[cursorVideo${index}][cursor${index + 1}]overlay=x='${x}':y='${y}':${OVERLAY}:enable='${enable}'[cursorVideo${index + 1}]`)
  })
  filters.push(`[cursorVideo${moves.length}]colorspace=ispace=bt470bg:iprimaries=bt709:itrc=bt709:all=bt709:format=yuv420p[final]`)
  if (audio) {
    const input = clicks.length ? 3 : 2
    const trim = number(Math.max(0, -audio.offset))
    const delay = number(Math.max(0, audio.offset) * 1000)
    // Reset the selected stream before trimming: its first sample may start after the container's video.
    filters.push(`[${input}:a:0]asetpts=PTS-STARTPTS,atrim=start=${trim},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,apad[finalAudio]`)
  }
  return filters.join(';')
}

function clickFilter(click, index, scale) {
  const start = number(click.at)
  const end = number(start + CLICK.duration)
  const growth = `(${CLICK.scaleStart}+${CLICK.scaleEnd - CLICK.scaleStart}*clip((t-${start})/${CLICK.duration},0,1))`
  return [
    `[pulse${index}]setpts=PTS-STARTPTS+${start}/TB,scale=w='iw*${growth}':h='ih*${growth}':eval=frame,fade=t=out:st=${start}:d=${CLICK.duration}:alpha=1[click${index}]`,
    `[video${index}][click${index}]overlay=x='${number(click.point.x * scale)}-w/2':y='${number(click.point.y * scale)}-h/2':${OVERLAY}:enable='between(t,${start},${end})'[video${index + 1}]`,
  ]
}

function number(value) {
  return Number(value.toFixed(6))
}
