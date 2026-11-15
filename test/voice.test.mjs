import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { PHONON_VERSION } from '../src/voice.mjs'

test('voice asks for the phonon-tts version it is tested with, as the README does', async () => {
  const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PHONON_VERSION, devDependencies['phonon-tts'])
  const quoted = [...(await readFile(new URL('../README.md', import.meta.url), 'utf8')).matchAll(/phonon-tts@(\d+\.\d+\.\d+)/g)]
  assert.ok(quoted.length)
  for (const [text, version] of quoted) assert.equal(version, PHONON_VERSION, text)
})
