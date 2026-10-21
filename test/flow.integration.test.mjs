import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

import { createFlowApi } from '../src/flow.mjs'

let browser
before(async () => { browser = await chromium.launch() })
after(() => browser.close())

async function withPage(html, run) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  try {
    await page.setContent(html)
    await page.mouse.move(20, 20)
    const trace = { initialPointer: { x: 20, y: 20 }, moves: [], clicks: [] }
    const api = createFlowApi({ page, trace, clock: Date.now(), viewport: { width: 800, height: 600 } })
    await run({ page, trace, api })
  } finally {
    await page.close()
  }
}

test('clicks visible targets in offset iframes and open shadow roots', { timeout: 30_000 }, async () => {
  await withPage(`
    <iframe style="position:absolute;left:300px;top:200px;width:220px;height:100px" srcdoc="<button onclick='this.textContent = &quot;Frame clicked&quot;'>Frame action</button>"></iframe>
    <div id="host"></div>
    <script>
      const root = document.querySelector('#host').attachShadow({ mode: 'open' })
      root.innerHTML = '<button onclick="this.textContent = \\'Shadow clicked\\'">Shadow action</button>'
    </script>
  `, async ({ page, trace, api }) => {
    const frameButton = page.frameLocator('iframe').getByRole('button', { name: 'Frame action' })
    await api.click(frameButton, { duration: 0.01, dwell: 0 })

    const shadowButton = page.locator('#host').getByRole('button', { name: 'Shadow action' })
    await api.click(shadowButton, { duration: 0.01, dwell: 0 })

    assert.equal(await page.frameLocator('iframe').getByRole('button').textContent(), 'Frame clicked')
    assert.equal(await page.locator('#host').getByRole('button').textContent(), 'Shadow clicked')
    assert.equal(trace.clicks.length, 2)
  })
})

test('clicks the center of a target in a scaled iframe', { timeout: 30_000 }, async () => {
  await withPage(`
    <iframe style="position:absolute;left:300px;top:200px;width:400px;height:200px;transform:scale(0.4);transform-origin:0 0" srcdoc="<button style='width:200px;height:60px' onclick='this.dataset.clicked = &quot;yes&quot;'>Scaled action</button>"></iframe>
  `, async ({ page, api }) => {
    const button = page.frameLocator('iframe').getByRole('button')
    await api.click(button, { duration: 0.01, dwell: 0 })
    assert.equal(await button.getAttribute('data-clicked'), 'yes')
  })
})

test('refuses to click an iframe target covered by the parent page', { timeout: 30_000 }, async () => {
  await withPage(`
    <iframe style="position:absolute;left:300px;top:200px;width:220px;height:100px" srcdoc="<button onclick='this.textContent = &quot;Frame clicked&quot;'>Frame action</button>"></iframe>
    <div id="overlay" style="position:fixed;inset:0;background:transparent" onclick="this.dataset.clicked = 'yes'"></div>
  `, async ({ page, trace, api }) => {
    const frameButton = page.frameLocator('iframe').getByRole('button', { name: 'Frame action' })

    await assert.rejects(api.click(frameButton, { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
    assert.equal(await page.locator('#overlay').getAttribute('data-clicked'), null)
    assert.equal(await frameButton.textContent(), 'Frame action')
    assert.equal(trace.clicks.length, 0)
  })
})

test('refuses to click when the pointer is over a cover, even if the target center is clear', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="this.textContent = 'Clicked'">Action</button>
    <div id="cover" style="position:absolute;left:0;top:0;width:60px;height:60px" onclick="this.dataset.clicked = 'yes'"></div>
  `, async ({ page, api }) => {
    await assert.rejects(api.click(page.getByRole('button'), { dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
    assert.equal(await page.locator('#cover').getAttribute('data-clicked'), null)
  })
})

test('clicks where the pointer is when only the target center is covered', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="this.textContent = 'Clicked'">Action</button>
    <div style="position:absolute;left:80px;top:0;width:40px;height:60px"></div>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button'), { dwell: 0 })
    assert.equal(await page.getByRole('button').textContent(), 'Clicked')
  })
})

test('clicks a shadow button whose label is slotted from the light DOM', { timeout: 30_000 }, async () => {
  await withPage(`
    <x-button><span>Slotted action</span></x-button>
    <script>
      customElements.define('x-button', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'open' }).innerHTML = '<button onclick="this.dataset.clicked = \\'yes\\'"><slot></slot></button>'
        }
      })
    </script>
  `, async ({ page, api }) => {
    const button = page.locator('x-button').getByRole('button')
    await api.click(button, { duration: 0.01, dwell: 0 })
    assert.equal(await button.getAttribute('data-clicked'), 'yes')
  })
})

test('waits for a disabled target to become enabled', { timeout: 30_000 }, async () => {
  await withPage(`
    <button disabled style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="this.dataset.clicked = 'yes'">Save</button>
    <script>setTimeout(() => { document.querySelector('button').disabled = false }, 300)</script>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.getByRole('button').getAttribute('data-clicked'), 'yes')
  })
})

test('refuses a click when a press style shrinks the target out from under the pointer', { timeout: 30_000 }, async () => {
  await withPage(`
    <style>button:active { transform: scale(0.8) }</style>
    <button style="position:absolute;left:10px;top:10px;width:200px;height:60px" onclick="this.textContent = 'Clicked'">Action</button>
  `, async ({ page, api }) => {
    await assert.rejects(api.click(page.getByRole('button'), { dwell: 0 }), { code: 'FLOW_TARGET_MOVED' })
    assert.equal(await page.getByRole('button').textContent(), 'Action')
  })
})

test('clicks a control that renames itself when pressed', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:100px;top:100px;width:200px;height:60px" onpointerdown="this.textContent = 'Pressed'" onclick="this.dataset.clicked = 'yes'">Action</button>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button', { name: 'Action' }), { duration: 0.01, dwell: 0 })
    assert.equal(await page.locator('button').getAttribute('data-clicked'), 'yes')
  })
})

test('clicks a control that removes itself when pressed', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:100px;top:100px;width:200px;height:60px" onmousedown="document.body.dataset.picked = 'yes'; this.remove()">Option</button>
  `, async ({ page, trace, api }) => {
    await api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.locator('body').getAttribute('data-picked'), 'yes')
    assert.equal(trace.clicks.length, 1)
  })
})

test('clicks a link that wraps onto two lines', { timeout: 30_000 }, async () => {
  await withPage(`
    <p style="margin:100px;width:200px;font:16px sans-serif;line-height:24px">Several plain words <a href="#" onclick="this.dataset.clicked = 'yes'">two lines</a> rest of it</p>
  `, async ({ page, api }) => {
    const link = page.getByRole('link')
    assert.equal(await link.evaluate((element) => element.getClientRects().length), 2)
    await api.click(link, { duration: 0.01, dwell: 0 })
    assert.equal(await link.getAttribute('data-clicked'), 'yes')
  })
})
