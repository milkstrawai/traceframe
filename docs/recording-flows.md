# Write a recording flow

Use this guide yourself or give it to a coding agent with the journey you want to show. Traceframe provides pointer and scrolling helpers; the supplied Playwright page handles typing, file selection, and application checks.

## Run the example

The package includes [a complete flow](../examples/recipes-flow.mjs) and [its local page](../examples/recipes.html). It types English and Arabic, waits for two simulated replies, selects a fake file, and clicks a final action in a panel below the fold, which `click` scrolls into view first. After a global installation and the [prerequisites](../README.md#prerequisites), run:

```sh
TRACEFRAME_EXAMPLES="$(npm root -g)/@milkstraw/traceframe/examples"
traceframe record \
  --url "file://$TRACEFRAME_EXAMPLES/recipes.html" \
  --flow "$TRACEFRAME_EXAMPLES/recipes-flow.mjs" \
  --preset draft --out ./recipes.mp4
```

In a repository clone, run `npx traceframe record --url "file://$PWD/examples/recipes.html" --flow ./examples/recipes-flow.mjs --preset draft --out ./recipes.mp4` instead. These shell commands use macOS/Linux path syntax. The flow itself has no application dependencies, external services, or credentials.

## Prepare the journey

Inspect the running application at the recording viewport. Pick a short journey with a visible result and known demo data. Use role, label, or test-id locators; `locator.describe()` can make errors clearer.

Put setup and page readiness in `ready({ page, signal })`. This runs after initial navigation and before recording. Use `--storage-state` for an existing login, and keep that file in an ignored directory. For headers, locale, or themes, see [optional startup settings](#optional-startup-settings).

## Choose the right actions

Use Traceframe's `click`, `hover`, and `move` for visible pointer actions. Direct `locator.click()` and `page.mouse` calls move the browser pointer without updating Traceframe's overlay or click pulses. Use Playwright for the other actions below; their page changes appear in the video.

For a target clipped by a scrollable panel or covered by a sticky header, try `await scroll(target)` before the click. For a tooltip, a toast, or a closing dialog, wait until it is gone, or give the click a longer `dwell`. A covered click fails with an error that it "is covered at the click point" (`FLOW_TARGET_OBSCURED`); `hover` does not check for covers. See the [scrolling rules and limits](../README.md#scrolling).

Both automatic scrolling and `scroll(target)` can move the outer page, which closes some lists. For those lists, use their own scrolling container through Playwright, for example `await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }))` to show the final options, then click the option. Wait for any opening animation before scrolling.

To show a result without a pointer action, use `await scroll(result)`. Centering a result taller than the view hides its start, so scroll to its heading or another element near its start instead.

Focus a field visibly, then type with a delay in milliseconds:

```js
await click(message)
await message.pressSequentially('A short question', { delay: 45 })
```

For an upload, hover the visible control, set the actual file input, and wait for the application's selected-file feedback. The visible label or drop zone and the input are often different elements:

```js
const dropZone = page.getByText('Choose a file', { exact: true })
const fileInput = page.getByLabel('Choose a file')
await hover(dropZone)
await fileInput.setInputFiles('./sample.txt')
await page.getByText('sample.txt').waitFor()
await wait(0.6)
```

A relative path is resolved from the directory where you run Traceframe. File selection does not show an operating-system file picker. The complete example supplies an in-memory fake file so it can run on its own.

## Wait for the current result

Before a follow-up, wait for the application to show that the current step is complete. For a conversation that appends completed replies, the example waits for the next reply by index. For streamed answers, wait for that request's completion indicator instead; the first visible text or a previous reply is not completion.

Set a Playwright timeout explicitly when an individual operation may exceed its usual 30 seconds, such as `await newReply.waitFor({ timeout: 60_000 })`. Use Traceframe's `wait(seconds)` for reading time. Each helper wait is limited to 30 seconds, and the whole flow has a 120-second timeout that `--flow-timeout` (`flowTimeout` in the API) raises.

## Add captions and reading time

For a review video, explain what the viewer should notice. Show the caption, pause before moving the pointer, perform the action, then hold the result. Start with about 12 characters per second and a 2.5-second minimum for reading, followed by a 2.5–4 second result hold.

Use Playwright's [`page.screencast.showOverlay()`](https://playwright.dev/docs/api/class-screencast#screencast-show-overlay) inside the flow. Keep the caption compact, centered, and clear of the controls and results being shown. Traceframe's covered-click check ignores this pointer-transparent caption; use `top: 32px` instead of `bottom: 32px` when it would hide controls or results near the bottom. Keep its handle and dispose of it after the result hold:

```js
const text = 'Open Actions to inspect the available options.'
const caption = await page.screencast.showOverlay(`
  <div style="position: fixed; left: 24px; right: 24px; bottom: 32px;
    display: flex; justify-content: center; pointer-events: none;">
    <div dir="auto" style="max-width: 720px; padding: 12px 20px; border-radius: 10px;
      background: #18181b; color: #fff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
      font: 500 20px/1.45 system-ui, sans-serif;
      text-align: center; text-wrap: balance;">
      ${text}
    </div>
  </div>
`)
try {
  await wait(Math.max(2.5, Array.from(text).length / 12))
  await click(page.getByRole('button', { name: 'Actions', exact: true }))
  await page.getByRole('menu').waitFor()
  await wait(3)
} finally {
  await caption.dispose()
}
```

Omit `duration` when actions should happen while the caption is visible. Playwright uses milliseconds for `duration`: awaiting `showOverlay(html, { duration: 3000 })` waits until the overlay is removed. The example uses fixed text; escape dynamic text before inserting it into HTML.

Playwright restores overlays after a full-page navigation, but they can briefly disappear while the new document loads. Opening a native modal `<dialog>` can also briefly cover an existing caption. For a clean caption transition, finish the reading pause and dispose of the current caption before the action that navigates or opens the dialog, then show the next caption after the destination or dialog is ready.

Keep captions short. Split longer text into separate captions so each reading pause stays within the helper's 30-second limit. Reading pauses and result holds count toward the flow timeout; for a longer video, raise it with, for example, `--flow-timeout 240` (seconds).

## Optional startup settings

`page.emulateMedia({ colorScheme: 'dark' })` in `ready` updates CSS themes that follow the browser's color scheme. If the app reads the setting only at startup, set it before opening the app, as below.

If the application needs request headers, a browser locale, or a color scheme from startup, record `--url about:blank` and open the application yourself in `ready`. Keep only the lines you need:

```js
export async function ready({ page }) {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setExtraHTTPHeaders({ 'x-demo-access': 'demo' })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setLocaleOverride', { locale: 'ar-EG' })
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: 'ar-EG' })
  await page.goto('http://localhost:3000')
  await page.getByRole('heading', { name: 'Example workspace' }).waitFor()
  await page.evaluate(() => document.fonts.ready)
}
```

The two `Emulation` calls set the locale that `navigator.language`, `Intl`, and the `Accept-Language` header use; the empty `userAgent` keeps Chromium's own user agent and client hints. Traceframe waits for web fonts only on the `--url` page, so the last line waits for the application's fonts.

## Record, inspect, and refine

Use `--preset draft` while writing the flow and the default preset for the final video.

While writing the flow, pass `--run-dir` with an ignored folder, such as `.traceframe/runs/demo`. A failed take then keeps its partial `capture.webm`, which has no cursor overlay and stops where the flow failed.

A failed take may already have submitted real jobs, so reset demo data before recording again. Check the important transitions and the final result. You can also check the file for decode errors:

```sh
ffmpeg -v error -xerror -i ./recording.mp4 -f null -
```

## Edit the finished video

Edit the finished MP4 with FFmpeg rather than changing the flow. Editing finished frames keeps the page and cursor together. Keep the original, and say when a clip's pacing was edited.

To speed up an idle stretch, such as a progress bar, you need its start and end times. Read them in a video player, or log them from the flow; logged times run up to about 0.1 seconds earlier than in the video:

```js
export default async function ({ page, click, wait }) {
  const started = Date.now()
  const mark = (label) => console.error(`${label}: ${((Date.now() - started) / 1000).toFixed(2)} s`)
  // ...
  mark('progress started')
}
```

Log to `console.error`, because Traceframe prints its JSON summary on standard output. This command plays seconds 2 to 9 at 4× speed. Set `fps` to the video's frame rate: 60 for the default preset, 30 for draft.

```sh
ffmpeg -i recording.mp4 -filter_complex "[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[0:v]trim=2:9,setpts=(PTS-STARTPTS)/4[b];[0:v]trim=9,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3,fps=60[v]" -map "[v]" -c:v libx264 -crf 18 -movflags +faststart faster.mp4
```

For an animated preview where an MP4 does not play inline, make a WebP. Not every FFmpeg build includes the WebP encoder.

```sh
ffmpeg -i recording.mp4 -vf "fps=12,scale=1280:-1" -c:v libwebp_anim -quality 75 -loop 0 preview.webp
```

## Optional sharing

With push access to a repository, current [GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) can attach the MP4 to a comment so it plays there; check `gh pr comment --help` for your version. An MP4 hosted elsewhere shows as a link, not a player, so use the WebP preview there. Upload only when asked and after checking that the recording suits the destination; recording itself uploads nothing.
