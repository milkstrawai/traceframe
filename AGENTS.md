# Repository

- Traceframe is an ES module package for Node.js 22+ with one dependency, Playwright, pinned to an exact version. `src/cli.mjs` is the command; `src/index.mjs` exports `record`, `recordPage` and `TraceframeError`.
- `README.md` is also the npm page. `docs/recording-flows.md` and three files in `examples/` ship in the package, and agents follow the guide while they record. Update both when behavior changes.
- Keep the published behavior stable: CLI commands, flags and exit codes, the exports, error codes, the fields of the result JSON, the rendered video and the package's file list. Describe any change to them in the commit message.
- After editing an SVG in `src/assets`, run `npm run build:assets` to rebuild its PNGs.

# Tests

- Tests need Playwright's Chromium for the pinned version (`npx playwright@<version> install --only-shell chromium`) and FFmpeg 5 or newer with `ffprobe`, `libx264`, AAC, and the `libvpx-vp9` and `libopus` encoders that some tests use to make fixtures.
- `npm test` runs every `test/*.test.mjs` file. Files named `*.integration.test.mjs` launch Chromium, and the whole suite takes a couple of minutes. For a quick check, run one file: `cd test && node --test <file>`.
- `npm run test:smoke` records the fixture flow (`TRACEFRAME_PRESET=standard` for the default preset), and `npm run test:package` installs the packed package and records with it. CI runs all three on Linux, macOS and Windows.
- Timing-sensitive tests can fail on a busy machine. Rerun a failed file on its own before treating the failure as real.

# Commits

- Write subjects as `type: summary`, with types such as `feat`, `fix`, `perf`, `docs`, `test`, `refactor` and `build`. In the body, explain in plain language why the change is needed and how it was checked.
- The release steps are in the README's Development section.

# Git and privacy

- Commit, push, open PRs, merge, tag releases, or publish packages only when the user explicitly requests that action. Authorization already given for the task remains valid.
- Keep credentials, authentication state, private application data, and internal conversations out of commits, public output, and uploads. Use synthetic data in examples and tests.
- `mds/` holds local research and plans. Keep it ignored; do not force-add, publish, or link its contents publicly without the owner's explicit request.
- Keep recordings and authentication files in ignored locations such as `.traceframe/` and `.auth/`. Upload recordings only when requested, after checking their contents for the destination.
- Before an authorized push or publication, inspect the exact diff and package file list for unintended or private files. Never bypass a secret-scanning block without the owner's explicit direction.

# Keep these in step

- A CLI flag: its entry in the option table in `src/cli.mjs` (the help is built from it, and `test/cli.test.mjs` checks the whole help), its check in `src/config.mjs`, and the README. Defaults and presets are defined in `config.mjs`. The help reads them, except the `--gpu` line, which names its default in words; the README and the recording guide repeat them.
- An option that only `record()` accepts, such as browser or page setup: add it to `LAUNCH_OPTIONS` in `src/config.mjs`, so `recordPage()` rejects it instead of ignoring it.
- Run-directory file names come from `runFiles()` in `src/config.mjs`; the README and the recording guide name them too.
- The Playwright version is pinned in `package.json` and `package-lock.json` and quoted in the README and the recording guide.
- Error codes, `error.diagnostics` fields and result JSON fields are public, so changing one breaks users. Update the README where it describes them.
