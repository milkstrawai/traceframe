# Traceframe

Traceframe records a scripted Chromium flow and renders an MP4 with a smooth cursor and click pulse. Everything runs locally: pages, flows, videos, and authentication state stay on your machine.

https://github.com/user-attachments/assets/38e02cd5-a9ba-4f3c-938c-159955353141

## Prerequisites

Traceframe requires Node.js 22+, system FFmpeg 5+ with `libx264` and `ffprobe` (for example, `brew install ffmpeg` or `sudo apt install ffmpeg`), plus Playwright's Chromium and recording FFmpeg:

```sh
npx playwright@1.64.1 install --only-shell chromium ffmpeg
```

The Playwright version must match Traceframe's dependency; another cached browser version will not be used. To use a system Chrome instead, pass `--browser` or set `CHROME_PATH`, and install Playwright's recording FFmpeg with `npx playwright@1.64.1 install ffmpeg`. Use Chrome 150 or later; with older versions, scrolling a target in a panel into view can fail. System FFmpeg renders the finished MP4; it does not replace Playwright's recording binary. In a sandbox, such as a coding agent's, allow Playwright's browser download and let Chromium start.

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

To check installation before touching your application, save this as `smoke.mjs`:

```js
export default async function ({ wait }) {
  await wait(0.2)
}
```

```sh
npx @milkstraw/traceframe record \
  --url 'data:text/html,<h1>Traceframe smoke</h1>' \
  --flow ./smoke.mjs --out ./smoke.mp4 \
  --preset draft
```

The [recording guide](docs/recording-flows.md) includes a runnable example and recipes for typing, uploads, scrolling without a click, request headers, the browser locale, asynchronous responses, failed takes, shortening idle time, animated previews, and sharing.

The `draft` preset uses a 1280×800 CSS viewport and produces 1280×800 at 30 FPS. The `standard` preset uses the same CSS viewport and encodes it at 2560×1600 at 60 FPS. The cursor and click pulses are always drawn at the full frame rate, but Chromium may capture page changes, such as scrolling and animations, at a lower rate at 2560×1600, depending on the machine. When that happens, the video repeats the last page frame until the next one arrives. The video is always the viewport size times `--scale`, so `--preset draft --scale 2` gives 2560×1600 at 30 FPS. The command prints a JSON summary when it finishes.

Use `--run-dir .traceframe/runs/name` (`runDirectory` in the API) to keep the raw capture and the FFmpeg filter file. Keep that directory out of Git, because the raw capture shows everything the page showed. With this option, a flow that fails after recording starts keeps its partial raw capture for inspection; it has no rendered cursor overlay. Without this option, temporary captures are removed.

## Have an agent create the flow

For a real application, ask your coding agent to inspect the running UI and create the flow from the user journey. This keeps selectors tied to the product and avoids manually guessing coordinates. For example:

```text
Create a Traceframe flow for this user journey: open Settings, change the theme, and save it.
Follow the Traceframe recording guide: https://github.com/milkstrawai/traceframe/blob/main/docs/recording-flows.md
Inspect the running application, use stable role or test-id locators, add a ready hook,
and use Traceframe's click, hover, move, scroll, and wait helpers for visible interactions.
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

`ready({ page, signal })` runs after initial navigation and before recording starts. `--ready-timeout` (30 seconds by default) is Playwright's timeout for the page load and for each Playwright call in `ready`; it does not limit other work in the hook. A flow can also export `initialPointer = { x, y }` to choose where the cursor starts. By default it starts near the lower left.

The default function receives `page`, `signal`, and five helpers: `move({ x, y }, { duration })`, `hover(locator, { duration })`, `click(locator, { duration, dwell })`, `scroll(locator)`, and `wait(seconds)`. A move takes 0.5 seconds unless you pass `duration`, and a click rests on the target for 0.25 seconds (`dwell`) before it presses. If the target is disabled, the click waits for it to become enabled. `scroll` smoothly centers a target vertically through the page and its scrollable containers and waits until scrolling stops, without moving the pointer. Use it to show a result, reveal a target clipped by a scrollable panel, or move a target away from a sticky header before a click. It also centers targets that are already on screen. Centering cannot clear every cover, such as a sticky bar taller than half the viewport or scrolling panel, or reveal content hidden by `overflow: clip`. A flow may contain at most 100 moves and 100 clicks, and each `duration`, `dwell`, and `wait` is at most 30 seconds. Error messages name the locator; give it a clearer name with Playwright's `locator.describe('Save settings')`.

The default function may run for 120 seconds, including waits for your backend. For longer flows, pass `--flow-timeout 300` (`flowTimeout: 300` in the API). This does not change Playwright's action timeouts.

`click` and `hover` use real Playwright mouse events and add their movement to the overlay timeline. When the point they aim at is outside the viewport, they first scroll the target smoothly into view, including its scrollable containers and iframes, and wait until scrolling stops. For a point already inside the viewport, they do not scroll automatically, even if a panel clips it or something covers it. Use `scroll(target)` first for clipping by a scrollable panel or a sticky header; wait for a dialog or toast to close. `click` fails with `FLOW_TARGET_OBSCURED` if the target is still covered when it presses. If the pointer is already inside the target's box, it stays where it is, so a hover effect that moves or resizes the target does not pull the cursor along. A click holds the mouse button for about 100 ms, as a person would, so press styles such as `:active` show in the video. Headless Chromium draws pages without a GPU, so on heavy pages, such as ones with blurred backgrounds, hover effects can appear a little after the cursor passes. A longer `duration`, or a `move` around hover-reactive elements, keeps this from showing. A flow receives an `AbortSignal`; helper calls stop promptly when the flow timeout is reached.

Playwright typing and scrolling appear in the captured page. Direct `page.mouse`, `locator.click()`, and dragging calls bypass Traceframe's cursor trace and click pulses, so use its pointer helpers for visible interactions. Only the starting page is recorded; new tabs and popups do not appear in the video.

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

To release, set the version in `package.json` and `package-lock.json`, push all release changes to `main`, and publish a GitHub Release with the tag `v<version>` on the final tested commit containing those changes. The Release workflow reruns CI and stages the package on npm. A maintainer downloads it with `npm stage download`, checks that its files match `npm pack` at the tag, and approves it on npmjs.com with 2FA.

After editing an SVG in `src/assets`, run `npm run build:assets` to rebuild its 1× and 2× PNGs.

To re-record the committed sample:

```sh
npx traceframe record --url "file://$PWD/examples/fixture.html" --flow ./examples/fixture-flow.mjs --out ./examples/sample-output.mp4
```
