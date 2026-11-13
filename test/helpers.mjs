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
