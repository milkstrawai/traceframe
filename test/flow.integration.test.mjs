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

for (const action of ['hover', 'click', 'scroll']) {
  test(`${action} releases replaced targets and temporary iframe handles`, { timeout: 30_000 }, async () => {
    await withPage('<iframe style="display:block;margin-top:1200px;width:400px;height:200px"></iframe>', async ({ page, api }) => {
      const frame = page.frames().find(frame => frame.parentFrame())
      await frame.setContent(`
        <div id="panel" style="height:100px;overflow:auto"><button style="margin-top:600px">Save</button></div>
        <script>
          window.targets = [new WeakRef(document.querySelector('button'))]
          panel.addEventListener('scroll', () => {
            const button = document.querySelector('button')
            const replacement = button.cloneNode(true)
            targets.push(new WeakRef(replacement))
            button.replaceWith(replacement)
          }, { once: true })
        </script>
      `)
      await api[action](frame.getByRole('button'), { duration: 0.01, dwell: 0 })
      await frame.evaluate(() => document.querySelector('button').remove())
      // Let Chromium finish the rendering lifecycle for the removed nodes before collecting them.
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.collectGarbage')
      assert.deepEqual(await frame.evaluate(() => targets.map(ref => Boolean(ref.deref()))), [false, false])
      await page.evaluate(() => {
        const iframe = document.querySelector('iframe')
        window.removedFrame = new WeakRef(iframe)
        iframe.remove()
      })
      await page.evaluate(() => new Promise(requestAnimationFrame))
      await cdp.send('HeapProfiler.collectGarbage')
      assert.equal(await page.evaluate(() => Boolean(removedFrame.deref())), false)
    })
  })
}

test('a failed click releases its target', { timeout: 30_000 }, async () => {
  await withPage('<button>Save</button><div style="position:fixed;inset:0"></div>', async ({ page, api }) => {
    await assert.rejects(api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
    await page.evaluate(() => {
      const button = document.querySelector('button')
      window.target = new WeakRef(button)
      button.remove()
    })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.collectGarbage')
    assert.equal(await page.evaluate(() => Boolean(target.deref())), false)
  })
})

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

test('refuses a click when the pointer rests on a cover over the target', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="this.textContent = 'Clicked'">Action</button>
    <div id="cover" style="position:absolute;left:0;top:0;width:60px;height:60px" onclick="this.dataset.clicked = 'yes'"></div>
  `, async ({ page, trace, api }) => {
    await assert.rejects(api.click(page.getByRole('button'), { dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
    assert.equal(await page.getByRole('button').textContent(), 'Action')
    assert.equal(await page.locator('#cover').getAttribute('data-clicked'), null)
    assert.equal(trace.moves.length, 0)
  })
})

test('clicks where the pointer is when only the target center is covered', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:absolute;left:0;top:500px;width:200px;height:60px" onclick="this.textContent = 'Clicked'">Action</button>
    <div style="position:absolute;left:80px;top:500px;width:40px;height:60px"></div>
    <div style="height:2000px"></div>
  `, async ({ page, trace, api }) => {
    await api.move({ x: 20, y: 520 }, { duration: 0.01 })
    await api.click(page.getByRole('button'), { dwell: 0 })
    assert.equal(await page.getByRole('button').textContent(), 'Clicked')
    assert.deepEqual(trace.clicks[0].point, { x: 20, y: 520 })
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

test('scrolls hidden targets into view in a panel, below the fold, and in an iframe', { timeout: 30_000 }, async () => {
  await withPage(`
    <div style="height:100px;overflow:auto"><div style="height:900px;display:flex;align-items:end"><button id="panel" onclick="this.textContent = 'Clicked'">Panel action</button></div></div>
    <button id="page" style="margin-top:1200px" onclick="this.textContent = 'Clicked'">Page action</button>
    <iframe style="display:block;margin-top:1200px;width:220px;height:100px" srcdoc="<button id='frame' onclick='this.textContent = &quot;Clicked&quot;'>Frame action</button>"></iframe>
  `, async ({ page, trace, api }) => {
    const targets = [page.locator('#panel'), page.locator('#page'), page.frameLocator('iframe').locator('#frame')]
    for (const target of targets) await api.click(target, { duration: 0.01, dwell: 0 })

    for (const target of targets) assert.equal(await target.textContent(), 'Clicked')
    assert.equal(trace.clicks.length, 3)
  })
})

test('does not scroll to a visible target while a tooltip covers it', { timeout: 30_000 }, async () => {
  await withPage(`
    <div style="height:480px"></div>
    <button onclick="this.textContent = 'Clicked'">Action</button>
    <div id="tooltip" style="position:absolute;left:0;top:470px;width:300px;height:60px;background:#ddd">Tooltip</div>
    <div style="height:2000px"></div>
  `, async ({ page, api }) => {
    await page.evaluate(() => document.addEventListener('mousemove', () => document.querySelector('#tooltip').remove(), { once: true }))
    await api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.getByRole('button').textContent(), 'Clicked')
    assert.equal(await page.evaluate(() => scrollY), 0)
  })
})

test('refuses a target that disappears when it is scrolled into view', { timeout: 30_000 }, async () => {
  await withPage(`
    <div id="menu" style="margin-top:1200px"><button>Menu item</button></div>
    <div style="height:600px"></div>
    <script>addEventListener('scroll', () => document.querySelector('#menu').remove(), { once: true })</script>
  `, async ({ page, api }) => {
    page.setDefaultTimeout(1500)
    await assert.rejects(api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_MISSING' })
  })
})

test('clicks a target that the page replaces while it scrolls', { timeout: 30_000 }, async () => {
  await withPage(`
    <section id="list" style="height:100px;overflow:auto"><div style="height:900px;display:flex;align-items:end"><button onclick="this.textContent = 'Clicked'">Action</button></div></section>
    <script>list.addEventListener('scroll', () => { const button = document.querySelector('button'); button.replaceWith(button.cloneNode(true)) }, { once: true })</script>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.getByRole('button').textContent(), 'Clicked')
  })
})

test('reveals a target clipped by an on-screen panel with explicit scroll', { timeout: 30_000 }, async () => {
  const options = Array.from({ length: 20 }, (_, index) => `<li><button${index === 15 ? ' id="target"' : ''} onclick="this.dataset.clicked = 'yes'">Option ${index}</button></li>`).join('')
  await withPage(`
    <div style="height:900px"></div>
    <ul style="height:100px;overflow:auto;margin:0">${options}</ul>
    <div style="height:2000px"></div>
    <script>scrollTo(0, 800)</script>
  `, async ({ page, api }) => {
    await assert.rejects(api.click(page.locator('#target'), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_OBSCURED' })
    assert.equal(await page.evaluate(() => scrollY), 800)
    await api.scroll(page.locator('#target'))
    await api.click(page.locator('#target'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.locator('#target').getAttribute('data-clicked'), 'yes')
  })
})

test('scrolls again when content above the target grows during the scroll', { timeout: 30_000 }, async () => {
  await withPage(`
    <div style="height:1500px"></div>
    <div id="lazy" style="height:100px"></div>
    <div style="height:100px"></div>
    <button onclick="this.textContent = 'Clicked'">Action</button>
    <div style="height:2000px"></div>
    <script>new IntersectionObserver(([entry], observer) => { if (entry.isIntersecting) { observer.disconnect(); lazy.style.height = '700px' } }).observe(lazy)</script>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 })
    assert.equal(await page.getByRole('button').textContent(), 'Clicked')
  })
})

for (const action of ['click', 'hover', 'scroll']) {
  test(`${action} waits for a target that briefly re-renders during scrolling`, { timeout: 30_000 }, async () => {
    await withPage(`
      <!doctype html>
      <section id="panel" style="height:350px;width:500px;overflow:auto;margin:100px"><div style="height:900px;display:flex;align-items:end"><button id="target" style="height:50px;width:180px" onclick="this.dataset.clicked='yes'">Action</button></div></section>
      <script>
        panel.addEventListener('scroll', () => {
          const button = document.querySelector('#target')
          const replacement = button.cloneNode(true)
          const loading = document.createElement('span')
          loading.style.height = '50px'
          loading.textContent = 'Loading…'
          button.replaceWith(loading)
          setTimeout(() => loading.replaceWith(replacement), 800)
        }, { once: true })
      </script>
    `, async ({ page, trace, api }) => {
      page.setDefaultTimeout(2000)
      const button = page.locator('#target')
      await api[action](button)
      if (action === 'click') assert.equal(await button.getAttribute('data-clicked'), 'yes')
      if (action === 'hover') assert.ok(await button.evaluate((element) => element.matches(':hover')))
      if (action === 'scroll') {
        assert.ok(await button.isVisible())
        assert.equal(trace.moves.length, 0)
      }
    })
  })

  test(`${action} waits for an animated replacement after scrolling`, { timeout: 30_000 }, async () => {
    await withPage(`
      <!doctype html>
      <style>
        body { margin:0 } #panel { margin:100px;width:500px;height:350px;overflow:auto }
        button { height:50px;width:180px } .enter { animation:enter .9s linear both }
        @keyframes enter { from { transform:translateY(100px) } to { transform:translateY(0) } }
      </style>
      <section id="panel"><div style="height:800px"></div><button id="target" onclick="this.dataset.clicked='yes'">Action</button><div style="height:800px"></div></section>
      <script>
        panel.addEventListener('scroll', () => {
          const button = document.querySelector('#target')
          const replacement = button.cloneNode(true)
          replacement.className = 'enter'
          const loading = document.createElement('div')
          loading.style.height = '50px'
          button.replaceWith(loading)
          setTimeout(() => loading.replaceWith(replacement), 800)
        }, { once: true })
      </script>
    `, async ({ page, trace, api }) => {
      page.setDefaultTimeout(3000)
      const button = page.locator('#target')
      await api[action](button)
      if (action === 'click') assert.equal(await button.getAttribute('data-clicked'), 'yes')
      if (action === 'hover') assert.ok(await button.evaluate((element) => element.matches(':hover')))
      if (action === 'scroll') {
        const before = await button.boundingBox()
        await page.waitForTimeout(1000)
        const after = await button.boundingBox()
        assert.ok(Math.abs(after.y - before.y) < 1, `Target moved ${after.y - before.y}px after scroll returned`)
        assert.equal(trace.moves.length, 0)
      }
    })
  })

  test(`${action} retries when content growth leaves a target clipped by its panel`, { timeout: 30_000 }, async () => {
    await withPage(`
      <!doctype html>
      <style>body { margin:0 } #list { margin:100px 40px;width:600px;height:220px;overflow:auto } button { height:40px;width:160px }</style>
      <section id="list"><div style="height:800px"></div><div id="placeholder" style="height:60px">Loading image</div><div style="height:50px"></div><button onclick="this.dataset.clicked='yes'">Action</button><div style="height:1000px"></div></section>
      <script>
        new IntersectionObserver(([entry], observer) => {
          if (!entry.isIntersecting) return
          observer.disconnect()
          placeholder.style.height = '350px'
        }).observe(placeholder)
      </script>
    `, async ({ page, trace, api }) => {
      const button = page.getByRole('button')
      await api[action](button)
      if (action === 'click') assert.equal(await button.getAttribute('data-clicked'), 'yes')
      if (action === 'hover') assert.ok(await button.evaluate((element) => element.matches(':hover')))
      if (action === 'scroll') assert.equal(trace.moves.length, 0)
      const panel = await page.locator('#list').boundingBox()
      const box = await button.boundingBox()
      assert.ok(box.y >= panel.y && box.y + box.height <= panel.y + panel.height)
    })
  })

  test(`${action} rejects an unreachable clipped target after scrolling without moving the pointer`, { timeout: 30_000 }, async () => {
    await withPage(`
      <!doctype html>
      <div style="height:800px"></div>
      <section style="height:220px;overflow:clip"><div style="height:500px;padding-top:360px"><button>Action</button></div></section>
      <div style="height:2000px"></div>
    `, async ({ page, trace, api }) => {
      const button = page.getByRole('button')
      await assert.rejects(api[action](button, { duration: 0.01, dwell: 0 }), {
        code: 'FLOW_TARGET_OUTSIDE_VIEWPORT', message: /could not be revealed by scrolling/,
      })
      assert.ok(await page.evaluate(() => scrollY > 0))
      const box = await button.boundingBox()
      assert.ok(box.y > 0 && box.y + box.height < 600)
      assert.equal(trace.moves.length, 0)
      assert.equal(trace.clicks.length, 0)
    })
  })
}

test('reports a replacement that keeps moving after scrolling', { timeout: 30_000 }, async () => {
  await withPage(`
    <!doctype html>
    <style>.enter { animation:enter 1s linear infinite alternate } @keyframes enter { to { transform:translateY(100px) } }</style>
    <section id="panel" style="margin:100px;height:350px;overflow:auto"><div style="height:800px"></div><button id="target">Action</button><div style="height:800px"></div></section>
    <script>
      panel.addEventListener('scroll', () => {
        const button = document.querySelector('#target')
        const replacement = button.cloneNode(true)
        replacement.className = 'enter'
        const loading = document.createElement('div')
        loading.style.height = button.offsetHeight + 'px'
        button.replaceWith(loading)
        setTimeout(() => loading.replaceWith(replacement), 800)
      }, { once: true })
    </script>
  `, async ({ page, trace, api }) => {
    page.setDefaultTimeout(1500)
    await assert.rejects(api.scroll(page.locator('#target')), {
      code: 'FLOW_TARGET_MOVED', message: /kept moving after it was scrolled into view/,
    })
    assert.equal(trace.moves.length, 0)
  })
})

test('refuses a target that cannot be scrolled into view', { timeout: 30_000 }, async () => {
  await withPage(`
    <button style="position:fixed;left:100px;top:700px" onclick="this.textContent = 'Clicked'">Action</button>
  `, async ({ page, trace, api }) => {
    await assert.rejects(api.click(page.getByRole('button'), { duration: 0.01, dwell: 0 }), { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
    assert.equal(await page.getByRole('button').textContent(), 'Action')
    assert.equal(trace.moves.length, 0)
  })
})

test('scrolls results into view without moving the pointer', { timeout: 30_000 }, async () => {
  await withPage(`
    <div style="height:100px;overflow:auto"><div style="height:400px;display:flex;align-items:end"><p id="panel">Panel result</p></div></div>
    <p id="page" style="margin-top:1200px">Page result</p>
    <iframe style="display:block;margin-top:1200px;width:220px;height:100px" srcdoc="<p id='frame' style='margin-top:400px'>Frame result</p>"></iframe>
  `, async ({ page, trace, api }) => {
    // The fraction of the result that the viewport, the panel, and the iframe leave in view.
    const shown = (result) => result.evaluate((element) => new Promise((resolve) => {
      new IntersectionObserver(([entry], observer) => {
        observer.disconnect()
        resolve(entry.intersectionRatio)
      }).observe(element)
    }))
    for (const result of [page.locator('#panel'), page.locator('#page'), page.frameLocator('iframe').locator('#frame')]) {
      await api.scroll(result)
      assert.equal(await shown(result), 1)
    }
    assert.equal(trace.moves.length, 0)
  })
})

test('centers a result that is already in view when explicitly scrolled', { timeout: 30_000 }, async () => {
  await withPage(`
    <div style="height:450px"></div>
    <div style="width:300px;transform:scale(1.013);transform-origin:0 0"><p id="result" style="margin:0;height:40px">Result</p></div>
    <div style="height:2000px"></div>
  `, async ({ page, api }) => {
    const result = page.locator('#result')
    await api.scroll(result)
    const box = await result.boundingBox()
    assert.ok(Math.abs(box.y + box.height / 2 - 300) < 1)
  })
})

test('scrolls a target out from under a sticky header', { timeout: 30_000 }, async () => {
  await withPage(`
    <header style="position:sticky;top:0;height:80px;background:#ddd">Header</header>
    <div style="height:1000px"></div>
    <button onclick="this.textContent = 'Clicked'">Action</button>
    <div style="height:2000px"></div>
    <script>scrollTo(0, document.querySelector('button').offsetTop - 30)</script>
  `, async ({ page, api }) => {
    const button = page.getByRole('button')
    await api.scroll(button)
    await api.click(button, { duration: 0.01, dwell: 0 })
    assert.equal(await button.textContent(), 'Clicked')
  })
})

test('refuses a result that cannot be scrolled into view', { timeout: 30_000 }, async () => {
  await withPage(`
    <p id="result" style="position:fixed;left:100px;top:700px">Result</p>
  `, async ({ page, api }) => {
    await assert.rejects(api.scroll(page.locator('#result')), { code: 'FLOW_TARGET_OUTSIDE_VIEWPORT' })
  })
})

test('refuses a result that the page hides while it scrolls', { timeout: 30_000 }, async () => {
  await withPage(`
    <p id="result" style="margin-top:1200px">Result</p>
    <div style="height:600px"></div>
    <script>addEventListener('scroll', () => { document.querySelector('#result').style.visibility = 'hidden' }, { once: true })</script>
  `, async ({ page, api }) => {
    page.setDefaultTimeout(1500)
    await assert.rejects(api.scroll(page.locator('#result')), { code: 'FLOW_TARGET_MISSING' })
  })
})

test('waits for the page behind a partly hidden sticky result to stop', { timeout: 30_000 }, async () => {
  await withPage(`
    <main style="height:6000px"><aside id="result" style="position:sticky;top:-60px;height:100px">Result</aside></main>
    <script>scrollTo(0, 1200)</script>
  `, async ({ page, api }) => {
    await api.scroll(page.locator('#result'))
    const stopped = await page.evaluate(() => scrollY)
    await api.wait(0.5)
    assert.equal(await page.evaluate(() => scrollY), stopped)
  })
})

test('waits for a target that briefly re-renders as the pointer arrives', { timeout: 30_000 }, async () => {
  await withPage(`
    <button id="target" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="this.dataset.clicked = 'yes'">Action</button>
    <script>
      target.addEventListener('pointerenter', () => {
        const replacement = target.cloneNode(true)
        const loading = document.createElement('span')
        loading.textContent = 'Loading…'
        target.replaceWith(loading)
        setTimeout(() => loading.replaceWith(replacement), 500)
      }, { once: true })
    </script>
  `, async ({ page, api }) => {
    await api.click(page.locator('#target'))
    assert.equal(await page.locator('#target').getAttribute('data-clicked'), 'yes')
  })
})

test('allows a hover that hides its target without changing the layout', { timeout: 30_000 }, async () => {
  await withPage(`
    <style>.row:hover span { visibility: hidden }</style>
    <div class="row" style="margin:100px;width:300px;height:60px"><span id="target">2 minutes ago</span></div>
  `, async ({ page, api }) => {
    const target = page.locator('#target')
    await api.hover(target)
    assert.equal(await target.evaluate((element) => getComputedStyle(element).visibility), 'hidden')
  })
})

test('does not scroll an accordion while it opens', { timeout: 30_000 }, async () => {
  const options = Array.from({ length: 8 }, (_, index) => `<button style="display:block;height:32px;margin:4px" onclick="this.dataset.clicked = 'yes'">Option ${index}</button>`).join('')
  await withPage(`
    <style>#content { overflow:hidden;height:0;transition:height .3s ease } #content.open { height:320px }</style>
    <div style="height:100px"></div>
    <button onclick="content.classList.add('open')">Show options</button>
    <section id="content">${options}</section>
    <div style="height:1500px"></div>
    <script>window.scrolls = []; addEventListener('scroll', () => scrolls.push(true), true)</script>
  `, async ({ page, api }) => {
    await api.click(page.getByRole('button', { name: 'Show options' }))
    const option = page.getByRole('button', { name: 'Option 7' })
    await api.click(option)
    assert.equal(await option.getAttribute('data-clicked'), 'yes')
    assert.deepEqual(await page.evaluate(() => scrolls), [])
  })
})

test('clicks a menu that opens with a clip animation and closes on page scroll', { timeout: 30_000 }, async () => {
  await withPage(`
    <style>button { width:120px;height:40px } #menu { clip-path:inset(0 0 100% 0);transition:clip-path .4s } #menu.open { clip-path:inset(0) }</style>
    <button id="open" style="position:absolute;top:200px;left:200px" onclick="menu.hidden=false; requestAnimationFrame(() => menu.classList.add('open'))">Open</button>
    <div id="menu" hidden style="position:absolute;top:260px;left:200px;width:250px;padding-top:250px"><button id="target" onclick="this.dataset.clicked='yes'">Action</button></div>
    <div style="height:2500px"></div>
    <script>addEventListener('scroll', () => menu.hidden = true)</script>
  `, async ({ page, api }) => {
    await api.click(page.locator('#open'))
    await api.click(page.locator('#target'))
    assert.equal(await page.locator('#target').getAttribute('data-clicked'), 'yes')
  })
})

for (const overflow of ['hidden', 'auto']) {
  test(`scrolls a target inside an overflow:${overflow} card out from under a sticky header`, { timeout: 30_000 }, async () => {
    await withPage(`
      <header style="position:sticky;top:0;height:100px;background:#ddd;z-index:3">Header</header>
      <div style="height:800px"></div>
      <section style="border-radius:12px;overflow:${overflow};padding:16px;width:400px"><button onclick="this.dataset.clicked='yes'">Action</button><p>Some text</p></section>
      <div style="height:2000px"></div>
      <script>scrollTo(0, document.querySelector('section').offsetTop - 30)</script>
    `, async ({ page, api }) => {
      const target = page.getByRole('button')
      await api.scroll(target)
      await api.click(target, { duration: 0.01, dwell: 0 })
      assert.equal(await target.getAttribute('data-clicked'), 'yes')
    })
  })
}

for (const nested of [false, true]) {
  test(`waits for every page around ${nested ? 'nested sticky iframes' : 'a sticky iframe'} to stop scrolling`, { timeout: 30_000 }, async () => {
    const wrap = (content) => `<main style="height:6000px"><iframe style="display:block;position:sticky;top:-30px;width:400px;height:200px;border:0" srcdoc="${content.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></main><script>scrollTo(0,1200)</script>`
    const content = '<body style="margin:0"><button id="target" style="height:100px;width:200px">Result</button></body>'
    await withPage(wrap(nested ? wrap(content) : content), async ({ page, api }) => {
      const outer = page.frameLocator('iframe')
      const target = (nested ? outer.frameLocator('iframe') : outer).locator('#target')
      await api.scroll(target)
      const positions = () => Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])))
      const stopped = await positions()
      await api.wait(0.6)
      assert.deepEqual(await positions(), stopped)
    })
  })
}
