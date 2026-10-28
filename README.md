# Traceframe

Traceframe records a scripted Chromium flow and renders an MP4 with a smooth cursor and click pulse. Everything runs locally: pages, flows, videos, and authentication state stay on your machine.

https://github.com/user-attachments/assets/38e02cd5-a9ba-4f3c-938c-159955353141

## Prerequisites

Traceframe requires Node.js 22+ and system FFmpeg 5+ with `libx264` and `ffprobe` to render the MP4 (for example, `brew install ffmpeg` or `sudo apt install ffmpeg`). Playwright uses its own Chromium and FFmpeg builds to record the page. Install them with the exact Playwright version Traceframe uses; other cached versions are not used:

```sh
npx playwright@1.64.1 install --only-shell chromium ffmpeg
```

To use system Chrome 150 or later, pass `--browser` or set `CHROME_PATH`, and install Playwright's recording FFmpeg with `npx playwright@1.64.1 install ffmpeg`. Older Chrome versions can fail to scroll targets inside panels.

In a sandbox, such as a coding agent's, allow Playwright's browser download and let Chromium start.

To record pages behind a login, pass a Playwright storage-state file with `--storage-state`. Keep it in `.auth/` or another ignored location.

## Record a video

Run Traceframe with `npx` without adding it to your project's dependencies. Pass your application URL and your own [flow file](#write-a-flow):

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

The [recording guide](docs/recording-flows.md) includes a runnable example and recipes for form input, asynchronous results, browser settings, and editing or sharing a recording.

Both presets use a 1280×800 CSS viewport. `draft` produces 1280×800 at 30 FPS; `standard` (the default) produces 2560×1600 at 60 FPS. The output dimensions are the viewport times `--scale`, so `--preset draft --scale 2` gives 2560×1600 at 30 FPS. The command prints a JSON summary when it finishes.

The cursor and click pulses are always drawn at the full frame rate. Chromium may capture page changes, such as scrolling and animations, at a lower rate at 2560×1600, depending on the machine. The video repeats the last page frame until the next one arrives.

Use `--run-dir .traceframe/runs/name` (`runDirectory` in the API) to keep the raw capture and FFmpeg filter file, including a partial capture if the flow fails during recording. On a preparation or recording failure, Traceframe also tries to save a viewport screenshot as `failure.png`. Keep that directory out of Git, because captures and screenshots can contain private page data.

When available, failure output includes the error code, flow-file locations, elapsed recording time, and paths to artifacts saved for that attempt. Without `--run-dir`, temporary captures are removed and no failure screenshot is saved.

## Write a flow

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

The optional `ready({ page, signal })` hook runs after initial navigation and before recording starts. Export `initialPointer = { x, y }` to choose where the cursor starts; by default it starts near the lower left.

### Helpers

The default function receives a Playwright `page`, an `AbortSignal` named `signal`, and five helpers:

| Helper | Use |
| --- | --- |
| `move({ x, y }, { duration })` | Move the pointer to viewport coordinates. |
| `hover(locator, { duration })` | Move the pointer to a locator. |
| `click(locator, { duration, dwell })` | Move, pause, and click a locator. |
| `scroll(locator)` | Center a target without moving the pointer. |
| `wait(seconds)` | Pause for reading time. |

A move takes 0.5 seconds by default. A click pauses on the target for 0.25 seconds (`dwell`) before pressing, and waits for a disabled target to become enabled. `click` and `hover` leave the pointer in place if it is already inside the target's box.

Error messages name the locator; give it a clearer name with Playwright's `locator.describe('Save settings')`.

### Scrolling

`click` and `hover` scroll automatically only when their aim point starts outside the viewport. They scroll smoothly through the page, scrollable containers, and iframes, and wait for scrolling to stop before moving the pointer.

`scroll(target)` smoothly centers the target vertically, even if it is already visible, and waits for scrolling to stop without moving the pointer. Use it to show a result or before clicking a target clipped by a scrollable panel or covered by a sticky header. Wait for a dialog or toast to close instead.

Centering can leave a target partly visible or covered, for example by a sticky bar taller than half the height of the viewport or its scrolling panel. It cannot reveal content hidden by `overflow: clip`. `click` fails with `FLOW_TARGET_OBSCURED` if the target is still covered when it presses.

### Timing and limits

`--ready-timeout` (default: 30 seconds) sets Playwright's default timeout during initial navigation and `ready`, for operations that accept a timeout. It does not set a deadline for the whole hook.

The default function may run for 120 seconds, including waits for your backend. For longer flows, pass `--flow-timeout 300` (`flowTimeout: 300` in the API). This does not change Playwright's action timeouts. Helper calls stop promptly when the flow timeout is reached.

A flow may contain at most 100 moves and 100 clicks, and each `duration`, `dwell`, and `wait` is at most 30 seconds.

### What appears in the video

Playwright typing and scrolling appear in the captured page. Direct `page.mouse`, `locator.click()`, and dragging calls bypass Traceframe's cursor trace and click pulses, so use its pointer helpers for visible interactions. Only the starting page is recorded; new tabs and popups do not appear in the video.

### Have an agent create the flow

You can ask a coding agent to inspect your running UI and write the flow from a journey:

```text
Create a Traceframe flow for this user journey: open Settings, change the theme, and save it.
Follow the Traceframe recording guide: https://github.com/milkstrawai/traceframe/blob/main/docs/recording-flows.md
Inspect the running application, use stable role or test-id locators, add a ready hook,
and use Traceframe's click, hover, move, scroll, and wait helpers for visible interactions.
Write the result to flow.mjs and explain how to run it.
```

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

Traceframe's own errors are `TraceframeError` instances (exported by the package) with a `code`, such as `READY_FAILED` or `FLOW_TARGET_OBSCURED`. Other exceptions thrown by the flow become `FLOW_FAILED`, with the original thrown value in `cause`; existing Traceframe error codes and causes are preserved.

When available, `error.diagnostics` contains:

| Field | Meaning |
| --- | --- |
| `flowLocations` | Locations in the supplied flow file, as `{ file, line, column }` objects with an absolute path and 1-based line/column. Empty when the error stack has no matching frame. |
| `recordingTime` | Elapsed seconds from the first captured frame for a capture-stage failure, measured before collecting failure artifacts. Omitted before the first frame and for later rendering failures. |
| `capturePath` | Absolute path to the retained raw capture, only when `runDirectory` was supplied and saving succeeded. |
| `screenshotPath` | Absolute path to the saved failure screenshot, only when `runDirectory` was supplied and the screenshot succeeded. |

A flow timeout may have no flow location because it is raised outside the blocked operation. Screenshots are best effort and have a five-second collection budget. Partial captures are saved before browser shutdown, with no fixed time limit so slower encoders can finish. Diagnostic failures do not replace the original error.

Pass `signal` to stop a recording early. Traceframe closes the browser, stops FFmpeg, and removes its temporary files before rejecting with the signal's reason. When you pass a signal, Traceframe leaves Ctrl-C and other termination signals to you. The CLI does this for you: the first Ctrl-C stops and cleans up, and a second one exits at once.

A stuck recording encoder can delay saving and cancellation indefinitely. A second Ctrl-C forces the CLI to exit and can discard the unfinished capture. API callers that need a hard shutdown deadline should run recording in a separate process they can terminate.

## Sample output

The committed sample is generated from the [repository's fixture flow](examples/fixture-flow.mjs) with the `standard` preset (2560×1600 at 60 FPS) and is about 12 seconds long:

[Download the sample video](https://github.com/milkstrawai/traceframe/blob/main/examples/sample-output.mp4)

The cursor and click-pulse artwork and the fixture page's icons were made for Traceframe and are distributed under this repository's MIT license.

The fixture page uses the [Inter](https://github.com/rsms/inter) font, included under the SIL Open Font License in `examples/fonts/OFL.txt`.

## Development

```sh
npm ci
npm test
npm run test:smoke
TRACEFRAME_PRESET=standard npm run test:smoke
npm run test:package
```

To release, set the version in `package.json` and `package-lock.json`, push all release changes to `main`, and publish a GitHub Release with the tag `v<version>` on the final tested commit containing those changes. The Release workflow reruns CI and stages the package on npm. A maintainer downloads it with `npm stage download <stage-id>`, checks that its files match `npm pack` at the tag, and approves it on npmjs.com with 2FA.

After editing an SVG in `src/assets`, run `npm run build:assets` to rebuild its 1× and 2× PNGs.

To re-record the committed sample:

```sh
npx traceframe record --url "file://$PWD/examples/fixture.html" --flow ./examples/fixture-flow.mjs --out ./examples/sample-output.mp4
```
