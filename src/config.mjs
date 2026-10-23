import { resolve } from 'node:path'

import { TraceframeError } from './errors.mjs'

const PRESETS = {
  standard: { viewport: { width: 1280, height: 800 }, scale: 2, fps: 60 },
  draft: { viewport: { width: 1280, height: 800 }, scale: 1, fps: 30 },
}

export function createConfig(options = {}) {
  const presetName = options.preset ?? 'standard'
  check(Object.hasOwn(PRESETS, presetName), `Unknown preset: ${presetName}`)
  const preset = PRESETS[presetName]

  const viewport = {
    width: options.viewportWidth ?? preset.viewport.width,
    height: options.viewportHeight ?? preset.viewport.height,
  }
  check(Number.isInteger(viewport.width) && viewport.width > 0, 'Viewport width must be a positive integer.')
  check(Number.isInteger(viewport.height) && viewport.height > 0, 'Viewport height must be a positive integer.')
  const scale = options.scale ?? preset.scale
  check(scale === 1 || scale === 2, 'Scale must be 1 or 2.')
  const video = {
    width: viewport.width * scale,
    height: viewport.height * scale,
    fps: options.fps ?? preset.fps,
  }
  check(video.fps === 30 || video.fps === 60, 'FPS must be 30 or 60.')
  check(video.width % 2 === 0 && video.height % 2 === 0, 'At scale 1, the viewport width and height must be even.')

  check(options.flow, 'A flow file is required (the flow option, or --flow).')
  check(options.url, 'A URL is required (the url option, or --url).')
  const output = resolve(options.output ?? 'traceframe.mp4')
  check(output.toLowerCase().endsWith('.mp4'), 'Output path must use the .mp4 extension.')
  const postRoll = options.postRoll ?? 0.3
  check(Number.isFinite(postRoll) && postRoll >= 0, 'Post-roll must be 0 or more seconds.')
  const readyTimeout = options.readyTimeout ?? 30
  check(Number.isFinite(readyTimeout) && readyTimeout > 0, 'Ready timeout must be more than 0 seconds.')
  const flowTimeout = options.flowTimeout ?? 120
  check(Number.isFinite(flowTimeout) && flowTimeout > 0, 'Flow timeout must be more than 0 seconds.')

  return {
    url: options.url,
    flow: resolve(options.flow),
    output,
    storageState: options.storageState,
    browser: options.browser ?? process.env.CHROME_PATH,
    viewport,
    video,
    scale,
    postRoll,
    readyTimeout,
    flowTimeout,
    runDirectory: options.runDirectory ? resolve(options.runDirectory) : undefined,
  }
}

function check(valid, message) {
  if (!valid) throw new TraceframeError(message, { code: 'INVALID_CONFIG' })
}
