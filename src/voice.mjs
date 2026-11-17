import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { missingBrowserError } from './browser.mjs'
import { drawCaptions } from './captions.mjs'
import { raceAbort } from './deadline.mjs'
import { TraceframeError } from './errors.mjs'
import { createNarration } from './narration.mjs'

// The phonon-tts version voice is tested with. It is installed beside Traceframe, not in the project being recorded
// (see phononDirectory).
export const PHONON_VERSION = createRequire(import.meta.url)('../package.json').devDependencies['phonon-tts']
// The two ways to run Traceframe with it, for errors.
const PHONON_INSTALL = `record with \`npx -p traceframe -p phonon-tts@${PHONON_VERSION} traceframe record ...\`, or install both once with \`npm install -g traceframe phonon-tts@${PHONON_VERSION}\``
// Phonon 31m (English, Apache-2.0) at a fixed revision, with each file's SHA-256.
const MODEL = {
  repository: 'gradium/phonon-31m-en',
  revision: '92741c5b07d085ff840e26fea8ce43110b87852f',
  files: {
    'config.json': 'b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85',
    'tokenizer.json': '691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936',
    'model.q8.gguf': 'a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae',
    'default-voice.safetensors': 'dc537478eaadc1a5257fcda2e3501ab81e14c111a5d95a5838f350db2afd0f1a',
  },
}
// Phonon uses threads only on a cross-origin isolated page, so its files are served from localhost with these headers.
const ISOLATED = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
// Module scripts and streamed WebAssembly need their types. Model files are read as bytes, whatever their type.
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }

// Starts the voice before the take: finds phonon-tts, downloads the model once, and loads it in a headless Chromium
// that a lower-priority process launches (voice-process.mjs). Returns the narration (narration.mjs) and close().
export async function startVoice({ executablePath, signal }) {
  const roots = { '/phonon/': phononDirectory(), '/model/': await downloadModel(signal) }
  const server = createServer(async (request, response) => {
    // A request line that is not a path, such as `//`, is answered 404 like any other unknown file.
    const path = URL.canParse(request.url, 'http://127.0.0.1') ? new URL(request.url, 'http://127.0.0.1').pathname : ''
    const root = Object.keys(roots).find((prefix) => path.startsWith(prefix))
    const body = path === '/' ? '<!doctype html>' : root && await readFile(join(roots[root], path.slice(root.length))).catch(() => undefined)
    response.writeHead(body ? 200 : 404, { ...ISOLATED, 'Content-Type': TYPES[extname(path)] ?? 'text/html' })
    response.end(body || undefined)
  })
  // Its output is ignored, so nothing mixes into the CLI's JSON summary.
  const child = fork(fileURLToPath(new URL('./voice-process.mjs', import.meta.url)), executablePath ? [executablePath] : [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = new Promise((resolve) => child.once('exit', resolve).once('error', resolve))
  async function close() {
    server.close()
    if (child.connected) child.disconnect()
    await exited
  }

  async function start() {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const [{ wsEndpoint, error }] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('The voice process stopped.') })])
    if (error) throw new Error(error)
    const browser = await chromium.connect(wsEndpoint)
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const rate = await page.evaluate(async () => {
      const { PhononTTS } = await import('/phonon/index.js')
      const model = { weights: { q8: '/model/model.q8.gguf' }, tokenizer: '/model/tokenizer.json', config: '/model/config.json', voices: { default: '/model/default-voice.safetensors' } }
      window.tts = await PhononTTS.load({ lang: 'en', model, cache: false })
      // The first line is slower while the model warms up.
      await window.tts.synth('Ready.')
      return window.tts.sampleRate
    })
    return createNarration({
      rate,
      speak: (text) => page.evaluate((text) => window.tts.synth(text), text).catch(voiceFailed),
      drawCaptions: (options) => drawCaptions(browser, options).catch(voiceFailed),
    })
  }
  try {
    return { ...await (signal ? raceAbort(start(), signal) : start()), close }
  } catch (error) {
    await close()
    signal?.throwIfAborted()
    throw missingBrowserError(error, executablePath) ?? new TraceframeError(`Voice could not start: ${error.message}`, { code: 'VOICE_FAILED', cause: error })
  }
}

function voiceFailed(error) {
  if (error instanceof TraceframeError) throw error
  throw new TraceframeError(`Voice failed: ${error.message}`, { code: 'VOICE_FAILED', cause: error })
}

// Traceframe's own location finds phonon-tts installed beside it: in the same npx run, globally, or in a project that
// installs Traceframe. The working directory still finds one installed in the project, as Traceframe 0.8 asked.
function phononDirectory() {
  for (const base of [import.meta.url, pathToFileURL(join(process.cwd(), 'index.js'))]) {
    const require = createRequire(base)
    let path
    try {
      path = require.resolve('phonon-tts/package.json')
    } catch {
      continue
    }
    const { version } = require(path)
    if (version !== PHONON_VERSION) {
      throw new TraceframeError(`Voice needs phonon-tts ${PHONON_VERSION}, but ${version} is installed in ${dirname(path)}. Update it there, or ${PHONON_INSTALL}.`, { code: 'VOICE_RUNTIME_MISSING' })
    }
    return dirname(path)
  }
  throw new TraceframeError(`Voice needs the phonon-tts package installed beside Traceframe: ${PHONON_INSTALL}. A project that installs Traceframe needs phonon-tts@${PHONON_VERSION} there too.`, { code: 'VOICE_RUNTIME_MISSING' })
}

// The model is data, so it downloads by itself on first use, into the user's cache.
async function downloadModel(signal) {
  const directory = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'traceframe', 'phonon-31m-en', MODEL.revision)
  let announced = false
  for (const [name, sha256] of Object.entries(MODEL.files)) {
    if (await access(join(directory, name)).then(() => true, () => false)) continue
    if (!announced) {
      process.stderr.write(`traceframe: Downloading the voice model (65 MB) to ${directory}\n`)
      await mkdir(directory, { recursive: true })
      announced = true
    }
    const url = `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${name}`
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('The file does not match its checksum.')
      // Written whole, then renamed, so a partial file never counts as downloaded.
      const temporary = join(directory, `.${randomUUID()}.tmp`)
      await writeFile(temporary, data)
      await rename(temporary, join(directory, name))
    } catch (cause) {
      signal?.throwIfAborted()
      throw new TraceframeError(`Could not download the voice model from ${url}: ${cause.message}`, { code: 'VOICE_FAILED', cause })
    }
  }
  return directory
}
