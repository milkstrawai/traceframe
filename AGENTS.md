# Git and privacy

- Commit, push, open PRs, merge, tag releases, or publish packages only when the user explicitly requests that action. Authorization already given for the task remains valid.
- Keep credentials, authentication state, private application data, and internal conversations out of commits, public output, and uploads. Use synthetic data in examples and tests.
- `mds/` holds local research and plans. Keep it ignored; do not force-add, publish, or link its contents publicly without the owner's explicit request.
- Keep recordings and authentication files in ignored locations such as `.traceframe/` and `.auth/`. Upload recordings only when requested, after checking their contents for the destination.
- Before an authorized push or publication, inspect the exact diff and package file list for unintended or private files. Never bypass a secret-scanning block without the owner's explicit direction.
