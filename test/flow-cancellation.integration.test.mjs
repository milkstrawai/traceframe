import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

import { createFlowApi } from '../src/flow.mjs'

let browser
before(async () => { browser = await chromium.launch() })
after(() => browser.close())

async function withPage(html, run) {
  const viewport = { width: 640, height: 480 }
  const page = await browser.newPage({ viewport })
  const controller = new AbortController()
  const trace = { initialPointer: { x: 20, y: 20 }, moves: [], clicks: [] }
  try {
    await page.setContent(html)
    await page.mouse.move(trace.initialPointer.x, trace.initialPointer.y)
    const api = createFlowApi({ page, trace, viewport, clock: Date.now(), signal: controller.signal })
    await run({ page, controller, trace, api })
  } finally {
    await page.close()
  }
}

test('aborting an enabled-state wait cannot deliver a later untraced click', { timeout: 15_000 }, async () => {
  await withPage('<button disabled onclick="this.dataset.clicked = 1">Save</button>', async ({ page, controller, trace, api }) => {
    const waiting = Promise.withResolvers()
    const button = page.getByRole('button')
    const getHandle = button.elementHandle.bind(button)
    button.elementHandle = async (options) => {
      const element = await getHandle(options)
      const wait = element.waitForElementState.bind(element)
      element.waitForElementState = (state, options) => {
        const pending = wait(state, options)
        if (state === 'enabled') waiting.resolve()
        return pending
      }
      return element
    }
    const rejected = assert.rejects(api.click(button, { duration: 0.01, dwell: 0 }))
    await waiting.promise
    controller.abort(new Error('take cancelled'))
    await button.evaluate(node => { node.disabled = false })
    await rejected
    assert.equal(await button.getAttribute('data-clicked'), null)
    assert.equal(trace.clicks.length, 0)
  })
})

test('aborting while waiting for a target prevents subsequent scrolling', { timeout: 15_000 }, async () => {
  await withPage('<div style="height:1800px"></div><button hidden>Later</button>', async ({ page, controller, api }) => {
    const waiting = Promise.withResolvers()
    const button = page.getByRole('button', { includeHidden: true })
    const wait = button.waitFor.bind(button)
    button.waitFor = (options) => {
      const pending = wait(options)
      waiting.resolve()
      return pending
    }
    const rejected = assert.rejects(api.scroll(button))
    await waiting.promise
    controller.abort(new Error('take cancelled'))
    await button.evaluate(node => { node.hidden = false })
    await rejected
    assert.equal(await page.evaluate(() => scrollY), 0)
  })
})

test('aborting hover while its target is replaced prevents later fulfillment', { timeout: 15_000 }, async () => {
  await withPage('<button style="position:absolute;left:100px;top:80px;width:100px;height:40px">Save</button>', async ({ page, controller, api }) => {
    page.setDefaultTimeout(0)
    await page.getByRole('button').evaluate(node => {
      node.addEventListener('mouseenter', () => { window.removedButton = node; node.remove() }, { once: true })
    })
    const waiting = Promise.withResolvers()
    const button = page.getByRole('button')
    const boundingBox = button.boundingBox.bind(button)
    button.boundingBox = (options) => {
      const pending = boundingBox(options)
      waiting.resolve()
      return pending
    }
    const rejected = assert.rejects(api.hover(button, { duration: 0.03 }), { name: 'AbortError' })
    await waiting.promise
    assert.equal(await button.count(), 0)
    controller.abort(new Error('take cancelled'))
    await page.evaluate(() => document.body.append(window.removedButton))
    await rejected
  })
})

test('cancellation after a press still releases the mouse button', { timeout: 15_000 }, async () => {
  await withPage('<button>Save</button><script>window.events = []; for (const name of ["mousedown", "mouseup"]) document.addEventListener(name, () => events.push(name))</script>', async ({ page, controller, api }) => {
    const down = page.mouse.down.bind(page.mouse)
    page.mouse.down = async () => {
      await down()
      controller.abort(new Error('cancel during press'))
    }
    await assert.rejects(api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 }))
    assert.deepEqual(await page.evaluate(() => events), ['mousedown', 'mouseup'])
  })
})
