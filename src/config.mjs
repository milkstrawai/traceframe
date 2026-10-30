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
  check(options.flow, 'A flow file is required (the flow option, or --flow).')
  check(options.url, 'A URL is required (the url option, or --url).')
  const readyTimeout = options.readyTimeout ?? 30
  check(Number.isFinite(readyTimeout) && readyTimeout > 0, 'Ready timeout must be more than 0 seconds.')

  return {
    ...recordingConfig(options, viewport, preset),
    url: options.url,
    flow: resolve(options.flow),
    storageState: options.storageState,
    browser: options.browser ?? process.env.CHROME_PATH,
    readyTimeout,
  }
}

export function createPageConfig(options = {}) {
  const { page } = options
  check(typeof page?.viewportSize === 'function' && page.screencast, 'A Playwright Page with screencast support is required.')
  check(!page.isClosed(), 'The supplied page is closed.')
  const viewport = page.viewportSize()
  check(viewport, 'recordPage requires a fixed viewport. Set it when creating the page or context; viewport: null is not supported.')
  for (const key of ['url', 'browser', 'storageState', 'readyTimeout', 'viewportWidth', 'viewportHeight', 'preset']) {
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
  check(video.width % 2 === 0 && video.height % 2 === 0, 'At scale 1, the viewport width and height must be even.')

  const output = resolve(options.output ?? 'traceframe.mp4')
  check(output.toLowerCase().endsWith('.mp4'), 'Output path must use the .mp4 extension.')
  const postRoll = options.postRoll ?? 0.3
  check(Number.isFinite(postRoll) && postRoll >= 0, 'Post-roll must be 0 or more seconds.')
  const flowTimeout = options.flowTimeout ?? 120
  check(Number.isFinite(flowTimeout) && flowTimeout > 0, 'Flow timeout must be more than 0 seconds.')
  const runDirectory = options.runDirectory ? resolve(options.runDirectory) : undefined

  return {
    output,
    audio: typeof options.audio === 'function' ? options.audio : createAudioConfig(options.audio, output, runDirectory),
    viewport: { ...viewport },
    video,
    scale,
    postRoll,
    flowTimeout,
    runDirectory,
  }
}

export function createAudioConfig(audio, output, directory) {
  if (audio === undefined) return undefined
  check(typeof audio?.path === 'string' && audio.path.length > 0, 'Audio must specify a local file path (--audio <path>, or audio: { path }).')
  const path = resolve(audio.path)
  check(path !== output, 'Audio input and video output must use different paths.')
  if (directory) {
    check(!['capture.webm', 'render.filter', 'failure.png'].some((name) => path === resolve(directory, name)), `Audio input must not use a reserved recording file: ${path}`)
  }
  const offset = audio.offset ?? 0
  check(Number.isFinite(offset), 'Audio offset must be a finite number of seconds.')
  return { path, offset }
}

function check(valid, message) {
  if (!valid) throw new TraceframeError(message, { code: 'INVALID_CONFIG' })
}
