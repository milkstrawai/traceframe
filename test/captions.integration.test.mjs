import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { drawCaptions } from '../src/captions.mjs'

test('draws whole captions that fit the viewport at either edge, even long ones on a small viewport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traceframe-captions-'))
  const browser = await chromium.launch()
  try {
    const small = { width: 320, height: 240 }
    const sentence = 'A very long line that would not fit. '
    const texts = ['Short line.', `${sentence.repeat(15)}${'W'.repeat(80)}`]
    const paths = texts.map((_, index) => join(directory, `${index}.png`))
    // Keep the caption page open afterwards, to check the last caption's text.
    let page
    const keepOpen = {
      async newContext(options) {
        const context = await browser.newContext(options)
        return { newPage: async () => (page = await context.newPage()), close: async () => {} }
      },
    }
    const drawn = await drawCaptions(keepOpen, { texts, viewport: small, scale: 2, paths })
    for (const [index, { box, image }] of drawn.entries()) {
      // 32 pixels from both edges, so the mirrored top position is 32 pixels from the top.
      assert.ok(box.y >= 32 && Math.abs(box.y + box.height - (small.height - 32)) < 0.5, `caption ${index} at ${box.y}, ${box.height} high`)
      assert.ok(image.x >= 0 && image.y >= 0)
      // The PNG is the box plus its shadow margin, at the video's scale, within rounding.
      const png = await readFile(paths[index])
      assert.ok(Math.abs(png.readUInt32BE(16) - (box.width + 2 * (box.x - image.x)) * 2) <= 2)
      assert.ok(Math.abs(png.readUInt32BE(20) - (box.height + 2 * (box.y - image.y)) * 2) <= 2)
    }
    // A short caption keeps the full-size type: one 29-pixel line plus its padding.
    assert.ok(Math.abs(drawn[0].box.height - 53) < 0.5, `short caption ${drawn[0].box.height} high`)
    // The long caption keeps all its text, an unbroken word included, in smaller type.
    const fit = await page.locator('#caption').evaluate((element) => ({
      whole: element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth,
      size: getComputedStyle(element).fontSize,
    }))
    assert.equal(fit.whole, true)
    assert.notEqual(fit.size, '20px')
    // A line too long even for the smallest type is refused rather than cut off.
    await assert.rejects(drawCaptions(browser, { texts: [sentence.repeat(40)], viewport: small, scale: 1, paths: [join(directory, 'long.png')] }), { code: 'INVALID_FLOW', message: /too long to caption/ })
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})
