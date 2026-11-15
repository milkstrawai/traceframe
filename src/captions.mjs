import { easePoint } from './easing.mjs'
import { TraceframeError } from './errors.mjs'

// The recording guide's caption recipe, drawn at the bottom of the viewport. A caption stays 32 pixels from both edges,
// so its image, shadow included, fits the viewport at the top too.
const CAPTION_PAGE = `<!doctype html><style>
body { margin: 0; background: transparent }
#bar { position: fixed; left: 24px; right: 24px; bottom: 32px; display: flex; justify-content: center }
#caption { max-width: 720px; max-height: calc(100vh - 88px); overflow: hidden; padding: 12px 20px; border-radius: 10px;
  background: #18181b; color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16); font: 500 20px/1.45 system-ui, sans-serif;
  text-align: center; text-wrap: balance; overflow-wrap: anywhere }
</style><div id="bar"><div id="caption" dir="auto"></div></div>`
// Room around each caption image for its shadow, in CSS pixels.
const SHADOW = 24
// Clear space kept around the element in use and around the pointer, in CSS pixels.
const TARGET_MARGIN = 12
const POINTER_MARGIN = 8
// The arrow in assets/cursor.svg, below and to the right of its tip.
const POINTER_SIZE = { width: 16, height: 20 }
const STEP = 1 / 30

// Saves each caption as a PNG with room for its shadow. Returns each caption's box at the bottom and where its image
// starts, in CSS pixels.
export async function drawCaptions(browser, { texts, viewport, scale, paths }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale })
  try {
    const page = await context.newPage()
    await page.setContent(CAPTION_PAGE)
    const caption = page.locator('#caption')
    const drawn = []
    for (const [index, text] of texts.entries()) {
      const whole = await caption.evaluate((element, text) => {
        element.textContent = text
        element.style.fontSize = ''
        // Text too long for the viewport gets smaller, down to a readable size, rather than cut off.
        for (let size = 19; element.scrollHeight > element.clientHeight && size >= 8; size--) element.style.fontSize = `${size}px`
        return element.scrollHeight <= element.clientHeight
      }, text)
      if (!whole) {
        throw new TraceframeError(`A say() line is too long to caption at this viewport size: "${text.slice(0, 60)}…". Split it into shorter lines, or turn captions off with voice = { captions: false }.`, { code: 'INVALID_FLOW' })
      }
      const box = await caption.boundingBox()
      const image = { x: box.x - SHADOW, y: box.y - SHADOW }
      await page.screenshot({ path: paths[index], omitBackground: true, clip: { ...image, width: box.width + 2 * SHADOW, height: box.height + 2 * SHADOW } })
      drawn.push({ box, image })
    }
    return drawn
  } finally {
    await context.close()
  }
}

// Where a caption's box goes: its top edge. `position` ('top' or 'bottom') fixes it. Otherwise the caption stays at
// the bottom unless there, while it is shown, it would cover the element in use or the moving pointer, and the top
// covers less. An element is in use from when the pointer sets off for it until it sets off elsewhere or the page
// scrolls; a resting pointer is on it or of no interest. The top keeps the bottom's distance from the edge.
export function captionY({ start, end, box, position }, trace, viewport) {
  const top = { ...box, y: viewport.height - box.y - box.height }
  position ??= coverage(top, start, end, trace) < coverage(box, start, end, trace) ? 'top' : 'bottom'
  return position === 'top' ? top.y : box.y
}

// How much a caption at `rect` would cover: each element in use counts more than any time over the pointer.
function coverage(rect, start, end, trace) {
  const elements = new Set()
  let pointerSeconds = 0
  for (let time = start; time < end; time += STEP) {
    const target = trace.targets.findLast((target) => target.at <= time)
    if (target?.box && overlaps(rect, grow(target.box, TARGET_MARGIN))) elements.add(target)
    const move = trace.moves.findLast((move) => move.at <= time)
    if (move && time <= move.at + move.duration) {
      const pointer = easePoint(move.from, move.to, (time - move.at) / move.duration)
      if (overlaps(rect, grow({ ...pointer, ...POINTER_SIZE }, POINTER_MARGIN))) pointerSeconds += STEP
    }
  }
  return elements.size * 100 + pointerSeconds
}

function grow({ x, y, width, height }, margin) {
  return { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin }
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
