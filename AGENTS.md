# Git and privacy

- Commit, push, open PRs, merge, tag releases, or publish packages only when the user explicitly requests that action. Authorization already given for the task remains valid.
- Keep credentials, authentication state, private application data, and internal conversations out of commits, public output, and uploads. Use synthetic data in examples and tests.
- `mds/` holds local research and plans. Keep it ignored; do not force-add, publish, or link its contents publicly without the owner's explicit request.
- Keep recordings and authentication files in ignored locations such as `.traceframe/` and `.auth/`. Upload recordings only when requested, after checking their contents for the destination.
- Before an authorized push or publication, inspect the exact diff and package file list for unintended or private files. Never bypass a secret-scanning block without the owner's explicit direction.

# Keep these in step

- A CLI flag: its entry in the option table in `src/cli.mjs` (the help is built from it), its check in `src/config.mjs`, and the README. Defaults and presets are defined in `config.mjs`. The help reads them, except the `--gpu` line, which names its default in words; the README and the recording guide repeat them.
- An option that only `record()` accepts, such as browser or page setup: add it to `LAUNCH_OPTIONS` in `src/config.mjs`, so `recordPage()` rejects it instead of ignoring it.
- Run-directory file names come from `runFiles()` in `src/config.mjs`; the README and the recording guide name them too.
- The Playwright version is pinned in `package.json` and `package-lock.json` and quoted in the README and the recording guide.
- Error codes, `error.diagnostics` fields and result JSON fields are public, so changing one breaks users. Update the README where it describes them.
