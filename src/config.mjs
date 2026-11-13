import { join, resolve } from 'node:path'

import { TraceframeError } from './errors.mjs'

export const PRESETS = {
  standard: { viewport: { width: 1280, height: 800 }, scale: 2, fps: 60 },
  draft: { viewport: { width: 1280, height: 800 }, scale: 1, fps: 30 },
}
export const DEFAULTS = {
  preset: 'standard',
  gpu: 'auto',
  readyTimeout: 30,
  captureQuality: 85,
  postRoll: 0.3,
  flowTimeout: 120,
  output: 'traceframe.mp4',
  audioOffset: 0,
}
// Browser and page setup that only record() does. recordPage() callers set up their own page, so it rejects these.
const LAUNCH_OPTIONS = ['url', 'browser', 'gpu', 'storageState', 'readyTimeout', 'viewportWidth', 'viewportHeight', 'preset']

export function createConfig(options = {}) {
  const presetName = options.preset ?? DEFAULTS.preset
  check(Object.hasOwn(PRESETS, presetName), `Unknown preset: ${presetName}`)
  const preset = PRESETS[presetName]

  const viewport = {
    width: options.viewportWidth ?? preset.viewport.width,
    height: options.viewportHeight ?? preset.viewport.height,
  }
  check(options.flow, 'A flow file is required (the flow option, or --flow).')
  check(options.url, 'A URL is required (the url option, or --url).')
  const readyTimeout = options.readyTimeout ?? DEFAULTS.readyTimeout
  check(Number.isFinite(readyTimeout) && readyTimeout > 0, 'Ready timeout must be more than 0 seconds.')
  const gpu = options.gpu ?? DEFAULTS.gpu
  check(['auto', 'off'].includes(gpu), 'GPU must be auto or off.')

  return {
    ...recordingConfig(options, viewport, preset),
    url: options.url,
    flow: resolve(options.flow),
    storageState: options.storageState,
    browser: options.browser ?? process.env.CHROME_PATH,
    gpu,
    readyTimeout,
  }
}

export function createPageConfig(options = {}) {
  const { page } = options
  check(typeof page?.viewportSize === 'function' && page.screencast, 'A Playwright Page with screencast support is required.')
  check(!page.isClosed(), 'The supplied page is closed.')
  const viewport = page.viewportSize()
  check(viewport, 'recordPage requires a fixed viewport. Set it when creating the page or context; viewport: null is not supported.')
  for (const key of LAUNCH_OPTIONS) {
    check(options[key] === undefined, `recordPage does not accept ${key}; prepare the page before recording and use scale/fps for video settings.`)
  }
  return recordingConfig(options, viewport, { scale: 1, fps: 30 })
}

function recordingConfig(options, viewport, defaults) {
  check(Number.isInteger(viewport.width) && viewport.width > 0, 'Viewport width must be a positive integer.')
  check(Number.isInteger(viewport.height) && viewport.height > 0, 'Viewport height must be a positive integer.')
  const scale = options.scale ?? defaults.scale
  check(scale === 1 || scale === 2, 'Scale must be 1 or 2.')
  const video = {
    width: viewport.width * scale,
    height: viewport.height * scale,
    fps: options.fps ?? defaults.fps,
  }
  check(video.fps === 30 || video.fps === 60, 'FPS must be 30 or 60.')
  const captureQuality = options.captureQuality ?? DEFAULTS.captureQuality
  check(Number.isInteger(captureQuality) && captureQuality >= 1 && captureQuality <= 100, 'Capture quality must be an integer from 1 to 100.')
  check(options.captureDiagnostics === undefined || typeof options.captureDiagnostics === 'boolean', 'Capture diagnostics must be a boolean.')
  check(video.width % 2 === 0 && video.height % 2 === 0, 'At scale 1, the viewport width and height must be even.')

  const output = resolve(options.output ?? DEFAULTS.output)
  check(output.toLowerCase().endsWith('.mp4'), 'Output path must use the .mp4 extension.')
  const postRoll = options.postRoll ?? DEFAULTS.postRoll
  check(Number.isFinite(postRoll) && postRoll >= 0, 'Post-roll must be 0 or more seconds.')
  const flowTimeout = options.flowTimeout ?? DEFAULTS.flowTimeout
  check(Number.isFinite(flowTimeout) && flowTimeout > 0, 'Flow timeout must be more than 0 seconds.')
  const runDirectory = options.runDirectory ? resolve(options.runDirectory) : undefined

  return {
    output,
    audio: typeof options.audio === 'function' ? options.audio : createAudioConfig(options.audio, output, runDirectory),
    viewport: { ...viewport },
    video,
    captureQuality,
    captureDiagnostics: options.captureDiagnostics ?? false,
    scale,
    postRoll,
    flowTimeout,
    runDirectory,
  }
}

export function runFiles(directory) {
  return {
    capture: join(directory, 'capture.mkv'),
    filter: join(directory, 'render.filter'),
    screenshot: join(directory, 'failure.png'),
  }
}

export function createAudioConfig(audio, output, directory) {
  if (audio === undefined) return undefined
  check(typeof audio?.path === 'string' && audio.path.length > 0, 'Audio must specify a local file path (--audio <path>, or audio: { path }).')
  const path = resolve(audio.path)
  check(path !== output, 'Audio input and video output must use different paths.')
  if (directory) {
    const root = resolve(directory)
    // Releases before 0.6.0 saved the capture as capture.webm, and the README still lists it as reserved.
    const reserved = [...Object.values(runFiles(root)), join(root, 'capture.webm')]
    check(!reserved.includes(path), `Audio input must not use a reserved recording file: ${path}`)
  }
  const offset = audio.offset ?? DEFAULTS.audioOffset
  check(Number.isFinite(offset), 'Audio offset must be a finite number of seconds.')
  return { path, offset }
}

function check(valid, message) {
  if (!valid) throw new TraceframeError(message, { code: 'INVALID_CONFIG' })
}
