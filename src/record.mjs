import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createConfig } from './config.mjs'
import { captureFlow } from './capture.mjs'
import { probeFfmpeg } from './ffmpeg.mjs'
import { loadFlow } from './flow.mjs'
import { renderVideo } from './render.mjs'

export async function record(options = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const config = createConfig(options)
  const ffmpeg = await probeFfmpeg()
  const flow = await loadFlow(config.flow, config.viewport)
  await mkdir(dirname(config.output), { recursive: true })
  const directory = config.runDirectory ?? await mkdtemp(join(tmpdir(), 'traceframe-'))
  await mkdir(directory, { recursive: true })

  try {
    const { rawPath, trace } = await captureFlow({ config, flow, directory, signal })
    const duration = await renderVideo({ rawPath, trace, directory, config, ffmpeg, signal })
    return {
      output: config.output,
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      duration,
      moveCount: trace.moves.length,
      clickCount: trace.clicks.length,
      runDirectory: config.runDirectory,
    }
  } catch (error) {
    throw signal?.aborted ? signal.reason : error
  } finally {
    if (!config.runDirectory) await rm(directory, { recursive: true, force: true })
  }
}
