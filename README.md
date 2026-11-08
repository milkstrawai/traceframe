# Traceframe

Traceframe records a scripted Chromium flow and renders an MP4 with a smooth cursor and click pulse. Everything runs locally: pages, flows, videos, and authentication state stay on your machine.

Browser capture is silent by default. Add an [external audio file](#add-audio) with explicit timing; tab audio and microphones are not captured automatically.

https://github.com/user-attachments/assets/38e02cd5-a9ba-4f3c-938c-159955353141

## Prerequisites

Traceframe requires Node.js 22+ and system FFmpeg 5+ with `libx264` and `ffprobe` to render the MP4 (for example, `brew install ffmpeg` or `sudo apt install ffmpeg`). Install Chromium with the exact Playwright version Traceframe uses; other cached versions are not used:

```sh
npx playwright@1.64.1 install --only-shell chromium
```

To use system Chrome 150 or later, pass `--browser` or set `CHROME_PATH`. Older Chrome versions can fail to scroll targets inside panels. Recording uses Playwright's frame callback and does not require its separate FFmpeg executable.

In a sandbox, such as a coding agent's, allow Playwright's browser download and let Chromium start.

To record pages behind a login, pass a Playwright storage-state file with `--storage-state`. See [creating saved login state and switching accounts](docs/recording-flows.md#save-and-switch-login-state), and keep state in `.auth/` or another ignored location.

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

The [recording guide](docs/recording-flows.md) includes a runnable example and recipes for authentication, form input, asynchronous results, captions, browser settings, and inspecting, editing or sharing a recording.

Both presets use a 1280×800 CSS viewport. `draft` produces 1280×800 at 30 FPS; `standard` (the default) produces 2560×1600 at 60 FPS. The output dimensions are the viewport times `--scale`, so `--preset draft --scale 2` gives 2560×1600 at 30 FPS. The command prints a JSON summary when it finishes.

The cursor and click pulses are always drawn at the full frame rate. Chromium may capture page changes, such as scrolling and animations, at a lower rate at 2560×1600, depending on the machine. The video repeats the last page frame until the next one arrives.

Use `--capture-diagnostics` (`captureDiagnostics: true` with `record` or `recordPage`) to include `captureStats` in the result. It reports received frames, their timestamp span and rate, the largest forward timestamp jumps and delivery gaps, and out-of-order timestamps. `lateFrames` counts frames older than the first received frame or the last written frame; `overflowFrames` counts frames dropped at the 64 MiB capture-buffer limit, and `maxBufferedBytes` reports its peak use. `writeWaitMs` and `maxWriteWaitMs` measure total and maximum time waiting for frame-write callbacks, including the final static frame; they do not measure durable disk writes. Slow writes can delay frame acknowledgments and reduce what Chromium sends, even when the writer drop counters stay at zero. These measurements describe frames delivered by Chromium. They do not count distinct pictures or prove smoothness; a static page legitimately delivers few frames, and a 30 FPS video cannot supply 60 distinct source frames per second.

`--capture-quality <1–100>` (`captureQuality` in either API) controls the JPEG frames exported by Chromium; the default is 85. In 3024 × 1964 tests, 85 made captured frames about a third smaller than 95, with slightly lower CPU use and no visible difference in the exported MP4. Quality did not change how many frames Chromium captured. Use 95 for maximum detail, or a lower setting such as 75 for smaller temporary captures with softer fine detail. This is separate from the final MP4 encoder. Check representative moving content and text at the intended resolution before choosing a non-default value.

Since v0.6.0, the retained raw file is `capture.mkv` instead of `capture.webm`; update scripts that inspect it. Final output remains MP4.

Traceframe saves Chromium's JPEG frames and presentation timestamps directly into a temporary `capture.mkv`, then encodes the final MP4 after the flow ends. This avoids a live intermediate video encode and works with CPU or GPU browser rendering. Chromium frame timestamps are retained with microsecond precision; a 150 ms buffer orders delayed arrivals. The first received frame establishes the audio clock, so subsequently delivered frames older than that origin are dropped. Slow storage applies backpressure. Moving content needs more temporary disk space than an inter-frame codec: at high resolution, allow hundreds of megabytes for short takes and potentially gigabytes for longer ones. Static pages need only a few stored frames. If your temporary directory is backed by RAM, choose a disk-backed `--run-dir` for large takes and remove it afterward. The final renderer supplies the requested frame rate while keeping cursor animations smooth.

GPU rendering can help the browser, but frame export still costs CPU. Use [`--gpu auto`](#gpu-rendering) to request verified acceleration with software fallback. When measuring performance, keep the browser version, source codec, viewport and device scale fixed, and compare recorded image updates and audio timing as well as file metadata.

Start performance comparisons with the Chromium build bundled with Playwright. A custom `--browser` executable can have different screencast performance even when recording succeeds. Traceframe preserves your requested resolution and quality. If the workload cannot sustain the desired cadence, increasing the encoded FPS repeats existing frames; choose a lower quality or smaller dimensions explicitly if that tradeoff suits your recording.

For video-heavy flows, see [checking video playback](docs/recording-flows.md#check-video-playback), including optional page effects and media sizing.

Use `--run-dir .traceframe/runs/name` (`runDirectory` in the API) to keep the raw capture and FFmpeg filter file, including a partial capture if the flow fails during recording. An interrupted or failed capture can be incomplete; a retained file is not proof that recording finalized successfully. On a preparation or recording failure, Traceframe also tries to save a viewport screenshot as `failure.png`. Keep that directory out of Git, because captures and screenshots can contain private page data.

When available, failure output includes the error code, flow-file locations, elapsed recording time, and paths to artifacts saved for that attempt. Without `--run-dir`, temporary captures are removed and no failure screenshot is saved. See [diagnosing a failed take](docs/recording-flows.md#diagnose-a-failed-take).

### GPU rendering

Add `--gpu auto` to a recording command, or `gpu: 'auto'` to `record()`. Traceframe checks Chromium's compositing status and renderer before navigation. If acceleration is unavailable or the GPU browser fails to start, it closes that attempt and tries software rendering once. Navigation, `ready` and the flow run only on the selected browser; a later recording failure is not retried.

| Setting | Behavior |
| --- | --- |
| `--gpu default` | Keep the browser's launch defaults; this is the default. |
| `--gpu auto` | Try hardware rendering, then fall back to software if it cannot be verified. |
| `--gpu off` | Explicitly request software rendering. |

Auto mode uses headless EGL on Linux and Chromium's platform backend elsewhere (Metal on the tested Mac). Override it with `--gpu-backend default`, `gl-egl`, or `metal` (`gpuBackend` in the API); an override requires auto mode and still permits fallback. GPU access and driver support depend on the environment. These launch configurations have recording evidence on Linux Intel/Mesa and Apple M3 Pro; Windows hardware acceleration has not been validated.

The JSON result includes `graphics`: `requested`, `hardwareAccelerated`, `compositing`, `rasterization` and `renderer`. `hardwareAccelerated: null` means the check was unavailable. Auto mode also reports `requestedBackend` and, on fallback, `fallbackReason`. These describe the startup graphics check, not GPU utilization or a guarantee of smooth playback. No GPU drivers or permissions are changed.

Auto and off modes keep video decoding in software. JPEG capture and final MP4 encoding still use CPU work; GPU rendering is not hardware video encoding. Smoother capture can store more frames and increase temporary storage and export time. For `recordPage`, configure the caller's browser yourself; GPU launch options are rejected, and the result reports its graphics with `requested: 'caller'`. Use full Chromium for extensions.

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

### Record a page you already opened

Use `recordPage` when your script already owns a Playwright page, including a page in a persistent extension context. Prepare navigation, authentication, application readiness and fonts before calling it. With a prepared `page`:

```js
import { recordPage } from '@milkstraw/traceframe'

const save = page.getByRole('button', { name: 'Save', exact: true })
await recordPage({
  page,
  output: './recording.mp4',
  flow: async ({ click, wait, signal }) => {
    await click(save)
    await page.getByText('Saved', { exact: true }).waitFor({ signal })
    await wait(3)
  },
})
```

The callback receives the same `page`, `signal` and five helpers as a flow file. It can close over your script's locators and state. See the [runnable existing-page example](examples/existing-page.mjs); in a clone, run `node examples/existing-page.mjs` to save `.traceframe/existing-page.mp4` using synthetic local content.

Use Playwright 1.64.1 with Chromium, a fixed viewport, 100% browser zoom and an unscaled page. Traceframe checks the page's inner dimensions and visual viewport before starting capture, rejecting unsupported geometry with `CAPTURE_SIZE_MISMATCH`. `recordPage` keeps the page, context and browser open on success, failure and cancellation. It does not navigate, resize, run a `ready` hook, or change page timeouts. Your script owns setup and shutdown. The CLI and `record` continue to create and close their own browser.

`page` and a function `flow` are required. `output`, `audio`, `postRoll`, `flowTimeout`, `runDirectory` and `signal` have the same meaning as in `record`, and the return value is the same recording summary. Set `initialPointer: { x, y }` to choose the starting cursor position. The page's viewport determines the dimensions; `scale` defaults to 1 and accepts 1 or 2, and `fps` defaults to 30 and accepts 30 or 60. Use these explicit settings instead of a preset. Browser setup options such as `url`, `browser`, `storageState`, viewport dimensions and `readyTimeout` are rejected.

Traceframe moves the caller's pointer only after validating the first frame. To show the starting hover state from frame 0, move the page's mouse to your chosen `initialPointer` before calling `recordPage`.

For 2× frames, launch the caller's browser with `chromium.launch({ args: ['--force-device-scale-factor=2'] })`, create its context with `deviceScaleFactor: 2`, and pass `scale: 2` to `recordPage`. The same launch argument works with `launchPersistentContext`. Setting `deviceScaleFactor` alone does not ensure 2× screencast frames. Traceframe checks the first JPEG's actual dimensions before running the callback and rejects mismatches with `CAPTURE_SIZE_MISMATCH`.

Keep the viewport, zoom and visual scale fixed and the page open until `recordPage` settles; geometry is checked only at startup. Only that page is recorded; a tab closed during a take may lose its capture. Use the page exclusively for recording: concurrent screencasts, context `recordVideo` and tracing with screenshots can change frame dimensions or supply stale frames. A size check cannot detect every conflict. Overlapping `recordPage` calls on the same page reject with `PAGE_RECORDING_ACTIVE`.

Await every helper. Helpers observe cancellation before further pointer or scroll actions, and release a mouse button that was already pressed; an already-issued action may still complete. Arbitrary callback code must cooperate with `signal`, including passing it to supported Playwright operations. A flow timeout does not forcibly terminate that code. Sequential takes are supported after a successful screencast stop, including ordinary flow failures and cooperative cancellation. Startup or stop failures may need a new page or context; Traceframe leaves that recovery to the caller and does not stop a pre-existing caller screencast.

Traceframe removes its temporary capture unless `runDirectory` is supplied. For extension pages, use full Chromium; the headless shell alone does not load extensions. This path was checked on Linux with Playwright 1.64.1 and its bundled full Chromium using a synthetic extension.

### Add audio

Both `record` and `recordPage` accept `audio: { path: './sound.wav', offset: 0 }`. The CLI accepts the same settings:

```sh
npx @milkstraw/traceframe record --url http://localhost:3000 --flow ./flow.mjs \
  --audio .traceframe/sound.wav --audio-offset 0.5 --out .traceframe/demo.mp4
```

`offset` is seconds from the first video frame to the first audio sample. Positive values add leading silence; negative values discard the beginning of the audio (in the CLI, use e.g. `--audio-offset=-0.25`). The default is 0. Short audio is padded with silence, and longer audio is trimmed to the video's end. Nothing is looped or stretched. The first audio stream is encoded as stereo AAC at 48 kHz, 192 kb/s; system FFmpeg must provide its standard `aac` encoder. Successful summaries include `audio: true`.

The input must be a local file, such as WAV, MP3, M4A or audio WebM. Static inputs are checked before browser recording, so a missing file or missing audio stream cannot waste a take (`AUDIO_INVALID`). After capture, an audio start at or after the video's end rejects with `AUDIO_OUTSIDE_VIDEO`. A negative offset that discards the entire source produces a silent audio track.

Traceframe reads the file without modifying or deleting it; use an input path different from the output and the reserved files in `runDirectory` (`capture.mkv`, legacy `capture.webm`, `render.filter`, `failure.png`). Keep recordings in an ignored directory.

For audio recorded alongside the flow, supply an async function instead. It runs once after successful capture and post-roll, before rendering, so it can finalize the external recorder and return its file. `startedAt` is the first video frame's timestamp in epoch milliseconds:

```js
await recordPage({
  page,
  output: '.traceframe/demo.mp4',
  flow,
  audio: async ({ startedAt, signal }) => {
    const { path, startedAt: audioStartedAt } = await finishAudioRecording({ signal })
    return { path, offset: (audioStartedAt - startedAt) / 1000 }
  },
})
```

Here `finishAudioRecording` belongs to your script and reports the timestamp of its first recorded sample. Use timestamps on a shared clock, or determine the offset using an audiovisual marker. An offset corrects a constant alignment difference; it does not correct clock drift. Check markers near both ends of longer takes. See the [audio workflow](docs/recording-flows.md#align-external-audio).

Your script owns the external recorder and its cleanup, including on flow failure or cancellation. The audio function is skipped if capture fails and must cooperate with `signal` when supplied. It may finish writing after capture; a static input must already exist before recording. Neither form captures browser or system sound by itself.

### Errors and cancellation

Traceframe's own errors are `TraceframeError` instances (exported by the package) with a `code`, such as `READY_FAILED` or `FLOW_TARGET_OBSCURED`. Other exceptions thrown by the flow become `FLOW_FAILED`, with the original thrown value in `cause`; existing Traceframe error codes and causes are preserved.

When available, `error.diagnostics` contains:

| Field | Meaning |
| --- | --- |
| `flowLocations` | Locations in the supplied flow file, as `{ file, line, column }` objects with an absolute path and 1-based line/column. Empty for a callback or when the error stack has no matching frame. |
| `recordingTime` | Elapsed seconds from the first captured frame for a capture-stage failure, measured before collecting failure artifacts. Omitted before the first frame and for later rendering failures. |
| `capturePath` | Absolute path to the retained raw capture, only when `runDirectory` was supplied and saving succeeded. |
| `screenshotPath` | Absolute path to the saved failure screenshot, only when `runDirectory` was supplied and the screenshot succeeded. |

A flow timeout may have no flow location because it is raised outside the blocked operation. Screenshots are best effort and have a five-second collection budget. Partial captures are flushed before browser shutdown, with no fixed time limit so slower storage can finish. Diagnostic failures do not replace the original error.

Pass `signal` to stop a recording early. Traceframe stops its recording/rendering work and removes its temporary files before rejecting with the signal's reason. `record` also closes its browser; `recordPage` leaves the caller's browser open. When you pass a signal, Traceframe leaves Ctrl-C and other termination signals to you. The CLI does this for you: the first Ctrl-C stops and cleans up, and a second one exits at once.

A stalled storage device can delay flushing and cancellation. A second Ctrl-C forces the CLI to exit and can discard unfinished writes. API callers that need a hard shutdown deadline should run recording in a separate process they can terminate.

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
