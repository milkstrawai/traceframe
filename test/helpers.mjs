import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function assertDecodes(path) {
  await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'])
}

// Points os.tmpdir() at directory while run() runs: it reads TMPDIR on Linux and macOS, and TEMP or TMP on Windows.
export async function withTemporaryDirectory(directory, run) {
  const names = ['TMPDIR', 'TEMP', 'TMP']
  const previous = names.map((name) => process.env[name])
  for (const name of names) process.env[name] = directory
  try {
    return await run()
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
}

// Audio of silence and loud noise, as [quiet, loud, quiet, ...] seconds at `rate`.
export function noise(rate, ...seconds) {
  const audio = new Float32Array(Math.round(seconds.reduce((sum, value) => sum + value, 0) * rate))
  let at = 0
  seconds.forEach((length, index) => {
    const end = at + Math.round(length * rate)
    if (index % 2) for (let sample = at; sample < end; sample++) audio[sample] = (sample % 7) / 7 - 0.4
    at = end
  })
  return audio
}
