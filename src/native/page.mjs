import { addAbortListener } from 'node:events'

import { TraceframeError } from '../errors.mjs'

const failure = (message) => new TraceframeError(message, { code: 'NATIVE_CAPTURE_FAILED' })
const paint = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

export async function calibrateViewport(page, scale, locate, signal) {
  const markers = await page.evaluateHandle(() => {
    const host = document.createElement('div')
    host.style.cssText = 'all:initial!important;display:contents!important'
    const root = host.attachShadow({ mode: 'closed' })
    document.documentElement.append(host)
    // Root zoom compounds through the shadow tree; keep the markers at 4 CSS pixels.
    const zoom = 1 / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)
    const corners = [
      'left:0;top:0;background:linear-gradient(to right,#ff00ff 50%,#00ffff 50%)',
      'right:0;bottom:0;background:linear-gradient(to right,#00ff00 50%,#ffff00 50%)',
    ].map((style) => {
      const marker = document.createElement('div')
      marker.style.cssText = `all:initial;forced-color-adjust:none;zoom:${zoom};position:fixed;width:4px;height:4px;pointer-events:none;margin:0;border:0;padding:0;inset:auto;${style};`.replaceAll(';', '!important;')
      marker.popover = 'manual'
      root.append(marker)
      marker.showPopover()
      return marker
    })
    return { host, corners }
  })
  let origin
  try {
    await paint(page)
    // Calibrate inside any application-controlled scrollbar gutters, then
    // include those gutters in the full recorded viewport.
    const box = await markers.evaluate(({ corners: [first, last] }) => {
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect()
      return { x: a.x, y: a.y, width: b.right - a.x, height: b.bottom - a.y }
    })
    signal.throwIfAborted()
    origin = await locate(box.width * scale, box.height * scale)
    origin.x -= box.x * scale
    origin.y -= box.y * scale
  } finally {
    await markers.evaluate(({ host }) => host.remove()).finally(() => markers.dispose())
  }
  await paint(page)
  return origin
}

export async function monitorPage({ page, browser, cdp, verify, fail, signal }) {
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const targets = await browser.newBrowserCDPSession()
  let timer, busy = false, closed = false
  const pageClosed = () => fail(failure('The recorded page closed during native capture.'))
  const popup = ({ targetInfo: target }) => {
    if (target.type === 'page' && target.targetId !== targetInfo.targetId) fail(failure('Native capture does not support new tabs or popups during recording.'))
  }
  const close = () => {
    closed = true
    clearInterval(timer)
    page.off('close', pageClosed)
    targets.off('Target.targetCreated', popup)
    listener[Symbol.dispose]()
  }
  const listener = addAbortListener(signal, close)
  try {
    signal.throwIfAborted()
    page.on('close', pageClosed)
    targets.on('Target.targetCreated', popup)
    await targets.send('Target.setDiscoverTargets', { discover: true, filter: [{ type: 'page' }] })
    signal.throwIfAborted()
    timer = setInterval(async () => {
      if (busy || closed) return
      busy = true
      try {
        await verify()
      } catch (error) {
        // Navigation briefly destroys the previous execution context.
        if (!closed && !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) fail(failure(`Could not monitor the captured page: ${error.message}`))
      } finally { busy = false }
    }, 125)
    return { close }
  } catch (error) {
    close()
    throw error
  }
}
