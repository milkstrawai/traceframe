import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createAudioConfig, createConfig, createPageConfig } from './config.mjs'
import { captureFlow } from './capture.mjs'
import { addDiagnostics, retainedFile } from './diagnostics.mjs'
import { probeAudio, probeFfmpeg } from './ffmpeg.mjs'
import { createFlow, loadFlow } from './flow.mjs'
import { renderVideo } from './render.mjs'
import { TraceframeError } from './errors.mjs'

const activePages = new WeakSet()

export async function record(options = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const config = createConfig(options)
  const ffmpeg = await probeFfmpeg({ audio: Boolean(config.audio) })
  const flow = await loadFlow(config.flow, config.viewport).catch(async (error) => {
    throw await addDiagnostics(error, { flow: config.flow })
  })
  return recordFlow({ config, flow, ffmpeg, signal })
}

export async function recordPage(options = {}) {
  const { page, signal } = options
  signal?.throwIfAborted()
  const config = createPageConfig(options)
  const flow = createFlow(options.flow, config.viewport, options.initialPointer)
  if (activePages.has(page)) throw new TraceframeError('This page is already being recorded by Traceframe.', { code: 'PAGE_RECORDING_ACTIVE' })
  activePages.add(page)
  try {
    const ffmpeg = await probeFfmpeg({ audio: Boolean(config.audio) })
    return await recordFlow({ config, flow, ffmpeg, signal, page })
  } finally {
    activePages.delete(page)
  }
}

async function recordFlow({ config, flow, ffmpeg, signal, page }) {
  let audio = typeof config.audio === 'function' ? undefined : config.audio
  if (audio) await probeAudio(audio.path, signal)
  await mkdir(dirname(config.output), { recursive: true })
  const directory = config.runDirectory ?? await mkdtemp(join(tmpdir(), 'traceframe-'))
  await mkdir(directory, { recursive: true })

  let capture
  let failed = false
  try {
    capture = await captureFlow({ config, flow, directory, signal, page })
    const { rawPath, trace } = capture
    if (typeof config.audio === 'function') {
      signal?.throwIfAborted()
      audio = createAudioConfig(await config.audio({ startedAt: capture.startedAt, signal }), config.output, directory)
      if (!audio) throw new TraceframeError('The audio function must return { path, offset }.', { code: 'INVALID_CONFIG' })
      await probeAudio(audio.path, signal)
    }
    const duration = await renderVideo({ rawPath, trace, directory, config, ffmpeg, signal, audio })
    return {
      output: config.output,
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      duration,
      moveCount: trace.moves.length,
      clickCount: trace.clicks.length,
      runDirectory: config.runDirectory,
      ...(audio ? { audio: true } : {}),
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
