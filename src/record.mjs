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
import { startVoice } from './voice.mjs'

const activePages = new WeakSet()

export async function record(options = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  const config = createConfig(options)
  const flow = await loadFlow(config.flow, config.viewport).catch(async (error) => {
    throw await addDiagnostics(error, { flow: config.flow })
  })
  return recordFlow({ config, flow, signal })
}

export async function recordPage(options = {}) {
  const { page, signal } = options
  signal?.throwIfAborted()
  const config = createPageConfig(options)
  const flow = createFlow(options.flow, config.viewport, options.initialPointer, options.voice)
  if (activePages.has(page)) throw new TraceframeError('This page is already being recorded by Traceframe.', { code: 'PAGE_RECORDING_ACTIVE' })
  activePages.add(page)
  try {
    return await recordFlow({ config, flow, signal, page })
  } finally {
    activePages.delete(page)
  }
}

async function recordFlow({ config, flow, signal, page }) {
  const ffmpeg = await probeFfmpeg({ audio: Boolean(config.audio || flow.voice) })
  let audio = typeof config.audio === 'function' ? undefined : config.audio
  if (audio) await probeAudio(audio.path, signal)
  await mkdir(dirname(config.output), { recursive: true })
  const directory = config.runDirectory ?? await mkdtemp(join(tmpdir(), 'traceframe-'))
  await mkdir(directory, { recursive: true })

  let capture
  let narration
  let failed = false
  try {
    // Voice starts before the browser, so a missing package or a failed model download cannot waste a take.
    if (flow.voice) narration = await startVoice({ executablePath: config.browser ?? process.env.CHROME_PATH, signal })
    capture = await captureFlow({ config, flow, directory, signal, page, narration })
    const { rawPath, trace } = capture
    // Before the narration is written, so audio returned at its path is refused rather than overwritten.
    if (typeof config.audio === 'function') {
      signal?.throwIfAborted()
      audio = createAudioConfig(await config.audio({ startedAt: capture.startedAt, signal }), config.output, directory)
      if (!audio) throw new TraceframeError('The audio function must return { path, offset }.', { code: 'INVALID_CONFIG' })
      await probeAudio(audio.path, signal)
    }
    const narrated = narration ? await narration.finish({ directory, trace, viewport: config.viewport, scale: config.scale, captions: flow.voice.captions, signal }) : {}
    await narration?.close()
    const duration = await renderVideo({ rawPath, trace, directory, config, ffmpeg, signal, audio, narration: narrated.audio, captions: narrated.captions })
    const lines = narrated.audio?.spoken ?? []
    return {
      output: config.output,
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      duration,
      startedAt: capture.startedAt,
      marks: trace.marks,
      moveCount: trace.moves.length,
      clickCount: trace.clicks.length,
      ...(narration ? { lineCount: lines.length, lines } : {}),
      graphics: capture.graphics,
      runDirectory: config.runDirectory,
      ...(audio || narrated.audio ? { audio: true } : {}),
      ...(capture.captureStats ? { captureStats: capture.captureStats } : {}),
    }
  } catch (error) {
    failed = true
    if (signal?.aborted) throw signal.reason
    if (capture && config.runDirectory) {
      await addDiagnostics(error, { flow: config.flow, capturePath: await retainedFile(capture.rawPath) })
    }
    throw signal?.aborted ? signal.reason : error
  } finally {
    await narration?.close()
    if (!config.runDirectory) {
      const cleanup = rm(directory, { recursive: true, force: true })
      if (failed) await cleanup.catch(() => {})
      else await cleanup
    }
  }
}
