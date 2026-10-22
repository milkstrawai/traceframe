# Traceframe

Traceframe records a scripted Chromium flow and renders an MP4 with a smooth cursor and click pulse. Everything runs locally: pages, flows, videos, and authentication state stay on your machine.

https://github.com/user-attachments/assets/38e02cd5-a9ba-4f3c-938c-159955353141

## Prerequisites

Traceframe requires Node.js 22+, FFmpeg 5+ with `libx264` and `ffprobe` (for example, `brew install ffmpeg` or `sudo apt install ffmpeg`), and Playwright's Chromium:

```sh
npx playwright@1.64.1 install --only-shell chromium
```

To use a system Chrome instead, pass `--browser` or set `CHROME_PATH`. Playwright still needs its own FFmpeg build to record the page, so install it with `npx playwright@1.64.1 install ffmpeg`.

To record pages behind a login, pass a Playwright storage-state file with `--storage-state`. Keep it in `.auth/` or another ignored location.

## Record a video

Run Traceframe with `npx` without adding it to your project's dependencies. Pass your application URL and your own flow file:

```sh
npx @milkstraw/traceframe record \
  --url http://localhost:3000 \
  --flow ./flow.mjs \
  --out ./recording.mp4
```

For regular use, you can install the command globally:

```sh
npm install -g @milkstraw/traceframe
traceframe record --url http://localhost:3000 --flow ./flow.mjs --out ./recording.mp4
```

The included fixture is available in a repository clone. It is not included in the installed package.

```sh
git clone https://github.com/milkstrawai/traceframe.git
cd traceframe
npm ci
npx traceframe record \
  --url "file://$PWD/examples/fixture.html" \
  --flow ./examples/fixture-flow.mjs \
  --out ./sample.mp4 \
  --preset draft
```

The `draft` preset uses a 1280×800 CSS viewport and produces 1280×800 at 30 FPS. The `standard` preset uses the same CSS viewport and encodes it at 2560×1600 at 60 FPS. The cursor and click pulses are always drawn at the full frame rate, but Chromium may capture page changes, such as scrolling and animations, at a lower rate at 2560×1600, depending on the machine. When that happens, the video repeats the last page frame until the next one arrives. The video is always the viewport size times `--scale`, so `--preset draft --scale 2` gives 2560×1600 at 30 FPS. The command prints a JSON summary when it finishes.

Use `--run-dir .traceframe/runs/name` (`runDirectory` in the API) to keep the raw capture and the FFmpeg filter file.

## Have an agent create the flow

For a real application, ask your coding agent to inspect the running UI and create the flow from the user journey. This keeps selectors tied to the product and avoids manually guessing coordinates. For example:

```text
Create a Traceframe flow for this user journey: open Settings, change the theme, and save it.
Inspect the running application, use stable role or test-id locators, add a ready hook,
and use Traceframe's click, hover, move, and wait helpers for visible interactions.
Write the result to flow.mjs and explain how to run it.
```

The flow module exports a default function. Timing values are seconds:

```js
export async function ready({ page }) {
  await page.getByRole('heading', { name: 'Example workspace' }).waitFor()
}

export default async function ({ page, click, wait }) {
  await click(page.getByRole('button', { name: 'Open settings' }), { duration: 0.8 })
  await wait(1)
}
```

`ready({ page, signal })` runs before recording starts. `--ready-timeout` (30 seconds by default) is Playwright's timeout for the page load and for each Playwright call in `ready`; it does not limit other work in the hook. A flow can also export `initialPointer = { x, y }` to choose where the cursor starts. By default it starts near the lower left.

The default function receives `page`, `signal`, and four helpers: `move({ x, y }, { duration })`, `hover(locator, { duration })`, `click(locator, { duration, dwell })`, and `wait(seconds)`. A move takes 0.5 seconds unless you pass `duration`, and a click rests on the target for 0.25 seconds (`dwell`) before it presses. If the target is disabled, the click waits for it to become enabled. A flow may contain at most 100 moves, 100 clicks, and 120 seconds of work, and each `duration`, `dwell`, and `wait` is at most 30 seconds. Error messages name the locator; give it a clearer name with Playwright's `locator.describe('Save settings')`.

`click` and `hover` use real Playwright mouse events and add their movement to the overlay timeline. If the pointer is already inside the target, it stays where it is, so a hover effect that moves or resizes the target does not pull the cursor along. A click holds the mouse button for about 100 ms, as a person would, so press styles such as `:active` show in the video. Headless Chromium draws pages without a GPU, so on heavy pages, such as ones with blurred backgrounds, hover effects can appear a little after the cursor passes. A longer `duration`, or a `move` around hover-reactive elements, keeps this from showing. Typing, scrolling, dragging, multiple tabs, and direct `page.mouse` or `locator.click()` calls are not currently represented in that timeline. A flow receives an `AbortSignal`; helper calls stop promptly when the duration limit is reached.

## Programmatic usage

To call Traceframe from JavaScript, install it in your project:

```sh
npm install @milkstraw/traceframe
```

```js
import { record } from '@milkstraw/traceframe'

await record({
  url: 'http://localhost:3000',
  flow: './flow.mjs',
  output: './recording.mp4',
  preset: 'standard',
})
```

Traceframe's own errors are `TraceframeError` instances (exported by the package) with a `code`, such as `READY_FAILED` or `FLOW_TARGET_OBSCURED`.

Pass `signal` to stop a recording early. Traceframe closes the browser, stops FFmpeg, and removes its temporary files before rejecting with the signal's reason. When you pass a signal, Traceframe leaves Ctrl-C and other termination signals to you. The CLI does this for you: the first Ctrl-C stops and cleans up, and a second one exits at once.

## Sample output

The committed sample is generated from the included fixture flow with the `standard` preset (2560×1600 at 60 FPS) and is about 12 seconds long:

[Download the sample video](https://github.com/milkstrawai/traceframe/blob/main/examples/sample-output.mp4)

The cursor and click-pulse artwork and the example page's icons were made for Traceframe and are distributed under this repository's MIT license.

The example page uses the [Inter](https://github.com/rsms/inter) font, included under the SIL Open Font License in `examples/fonts/OFL.txt`.

## Development

```sh
npm ci
npm test
npm run test:smoke
TRACEFRAME_PRESET=standard npm run test:smoke
npm run test:package
```

After editing an SVG in `src/assets`, run `npm run build:assets` to rebuild its 1× and 2× PNGs.

To re-record the committed sample:

```sh
npx traceframe record --url "file://$PWD/examples/fixture.html" --flow ./examples/fixture-flow.mjs --out ./examples/sample-output.mp4
```
