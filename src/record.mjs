import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createConfig } from './config.mjs'
import { captureFlow } from './capture.mjs'
import { addDiagnostics, retainedFile } from './diagnostics.mjs'
import { probeFfmpeg } from './ffmpeg.mjs'
import { loadFlow } from './flow.mjs'
import { renderVideo } from './render.mjs'

export async function record(options = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const config = createConfig(options)
  const ffmpeg = await probeFfmpeg()
  const flow = await loadFlow(config.flow, config.viewport).catch(async (error) => {
    throw await addDiagnostics(error, { flow: config.flow })
  })
  await mkdir(dirname(config.output), { recursive: true })
  const directory = config.runDirectory ?? await mkdtemp(join(tmpdir(), 'traceframe-'))
  await mkdir(directory, { recursive: true })

  let capture
  let failed = false
  try {
    capture = await captureFlow({ config, flow, directory, signal })
    const { rawPath, trace } = capture
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
    failed = true
    if (signal?.aborted) throw signal.reason
    if (capture && config.runDirectory) {
      await addDiagnostics(error, { flow: config.flow, capturePath: await retainedFile(capture.rawPath) })
    }
    throw signal?.aborted ? signal.reason : error
  } finally {
    if (!config.runDirectory) {
      const cleanup = rm(directory, { recursive: true, force: true })
      if (failed) await cleanup.catch(() => {})
      else await cleanup
    }
  }
}
