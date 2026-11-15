// Voice runs Phonon in its own headless Chromium, which this process only launches. Lowering this process's priority
// first lowers Chromium's and its speech threads' too, so the recording comes first when both need the processor.
// The parent drives the browser and decides when it stops; when the parent disconnects, exiting closes the browser.
import { setPriority } from 'node:os'
import { chromium } from 'playwright'

setPriority(10)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {})
process.on('disconnect', () => process.exit())
try {
  const server = await chromium.launchServer({ executablePath: process.argv[2], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  process.send({ wsEndpoint: server.wsEndpoint() })
} catch (error) {
  process.send({ error: error.message })
}
