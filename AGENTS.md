# Development

- Users depend on these, so change them only on purpose: the `traceframe record` command, its flags and exit codes, the exports, error codes, `error.diagnostics` and result JSON fields, the rendered video, and the package's file list. When you do, say so in the commit message.
- `README.md` is the npm page, and agents follow `docs/recording-flows.md` while they record. Update both when behavior changes.
- CI runs the tests on Linux, macOS and Windows, so keep paths, temporary files and signals portable.
- Timing-sensitive tests can fail on a busy machine. Rerun a failed file on its own before treating the failure as real.
- After editing an SVG in `src/assets`, run `npm run build:assets` to rebuild its PNGs.
- In commit bodies, explain in plain language why the change is needed and how it was checked.

# Git and privacy

- Commit, push, open PRs, merge, tag releases, or publish packages only when the user explicitly requests that action. Authorization already given for the task remains valid.
- Keep credentials, authentication state, private application data, and internal conversations out of commits, public output, and uploads. Use synthetic data in examples and tests.
- `mds/` holds local research and plans. Keep it ignored; do not force-add, publish, or link its contents publicly without the owner's explicit request.
- Keep recordings and authentication files in ignored locations such as `.traceframe/` and `.auth/`. Upload recordings only when requested, after checking their contents for the destination.
- Before an authorized push or publication, inspect the exact diff and package file list for unintended or private files. Never bypass a secret-scanning block without the owner's explicit direction.
