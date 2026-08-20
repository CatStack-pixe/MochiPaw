# Project Handoff

## Current Status

- Investigated `C:\Users\LEGION\Downloads\MochiPaw (6).log` from 2026-08-20. The log showed a submodel reaching `modelReady=true`, one unrelated updater network error, and Tao event-loop debug warnings, but no Live2D crash or main-window lifecycle failure. The strongest explanation for the reported invisible pet and half-screen input loss was a transparent submodel WebView remaining interactive while its model was not rendered, potentially combined with a stale or hidden submodel window.
- Fixed submodel input interception. `src/utils/subModelWindow.ts` now forces cursor pass-through during creation, synchronization, loading, failure, hiding, and destruction; restores the configured interaction mode only after the submodel reports both model-ready and rendering-enabled; serializes per-instance lifecycle operations; ignores stale runtime generations; logs actual window position, size, visibility, and lifecycle failures; rejects invalid persisted coordinates without changing them; and removes stale windows, including windows not configured for launch. `src/pages/main/index.vue` reports runtime readiness around actual Live2D loading and disables interaction when rendering is turned off. `src/App.vue` cleans stale submodel windows during main-window startup, restores them only from the main window, and destroys windows rejected by capacity or failed restoration.
- Added `src/utils/subModelWindow.test.ts` covering configured interaction, hidden/not-ready windows, and disabled rendering. Verification for this fix: `pnpm test` 158/158, `pnpm exec tsc --noEmit`, focused ESLint, `pnpm build:vite`, and `git diff --check` passed. Vite emitted only the existing third-party PURE annotation and bundle-size warnings.

- PR #92 was squash-merged as `67737f5`, release PR #93 was squash-merged as `2d91d3b`, and stable `v1.2.0` was published from tag `v1.2.0` on 2026-08-16. The release body follows the prior `## What's New` format and covers all changes after v1.1.10 with PR references #91, #92, and #93. The release workflow completed all five platform builds, signed assets, portable Windows archive, and updater finalization successfully; downloaded `latest-v2.json` reports version `1.2.0`, all platform entries, and the custom release notes.
- Replaced the Pomodoro today's numeric input with a persisted phase timeline. The Preferences page now shows a color-coded focus/short-break/long-break time track from midnight to the selected time, a read-only completed count, recent-30-day date selection, live running segments, tooltips, midnight splitting, and automatic 30-day pruning. Manual count editing and the `set-today-completed` command were removed. Commit `64fffc8` is pushed to PR #92; all four CI jobs passed and a findings-first audit found no blocking or actionable issues. Verification: `pnpm test` 148/148, TypeScript, Vite build, locale JSON parsing, and `git diff --check` passed; ESLint reports only the pre-existing UnoCSS ordering warning.
- Added a manual action icon beside each Pomodoro shortcut input. Start and resume use the play triangle, pause uses the pause icon, and reset uses the reset icon; each invokes the existing command acknowledgement flow with loading/duplicate-request protection. The icons use the same fixed-size UnoCSS `div` containers as existing visible shortcut actions, fixing the prior empty-button rendering. Commit `49acd9e` is pushed to PR #92; all four CI jobs passed and a findings-first audit found no blocking or actionable issues. Verification: `pnpm test` 144/144, TypeScript, Vite build, and `git diff --check` passed; ESLint reports only the pre-existing UnoCSS ordering warning.
- Pomodoro control actions are now configured directly on the Pomodoro preferences page as four global shortcut inputs: start, pause, resume, and reset. The in-page action buttons and the duplicate generic-shortcut entries were removed. Commit `9855aaf` was pushed to PR #92; all four CI jobs passed and a findings-first audit found no blocking or actionable issues. Verification: `pnpm test` 144/144, TypeScript, ESLint (one pre-existing shortcut UnoCSS ordering warning), Vite build, and `git diff --check` passed.
- Follow-up runtime visibility and updater fix is prepared: the transparent main-window countdown now uses high-contrast white text with a dark outline, and the updater falls back to the GitHub Release API when Tauri metadata has empty notes. Release finalization now copies the draft Release body into `latest-v2.json` and enables generated release notes, so future update dialogs show the actual GitHub description.
- Added `fetchGitHubReleaseBody` with a five-second timeout and focused success/failure tests; updater metadata tests now cover copying and validating release descriptions. Verification: `pnpm test` 141/141, updater script tests 12/12, TypeScript, Vite build, and `git diff --check` passed; ESLint has only the existing shortcut UnoCSS ordering warning.
- Worktree changes are ready for the next PR #92 head; the PR remains open and no squash merge is performed.
- PR #92 was pushed at `304fe1c`, all four remote CI jobs passed, labels remain `enhancement` and `windows`, and a findings-first review found no blocking or actionable issues. Residual risk is limited to GitHub API availability for the client-side fallback; failures leave the update description empty without blocking installation.
- Follow-up display diagnosis: the active persisted cat scale was `15%`, producing an effectively invisible `3.6px` countdown even though `displayEnabled` was true. `pomodoroDisplay` now enforces a 12px readable minimum and includes a regression test; `pnpm test` passes 142/142, TypeScript and focused ESLint pass, and `git diff --check` passes.
- Current follow-up redesign: Pomodoro preferences now persist automatically with a short debounce and no Save button; today's completed count is directly editable instead of a clear-only action. The low-scale timer baseline still remains readable while its 50-200% display multiplier visibly changes the font size. Main-window global shortcuts now include a start/pause/resume toggle plus reset and skip, independent of the Preferences window lifetime. Notification permission is requested on enable and audio resumes a reusable `AudioContext` before playback. Verification: `pnpm test` 144/144, TypeScript, ESLint (one pre-existing shortcut UnoCSS warning), Vite build, JSON locale parsing, and `git diff --check` passed.
- PR #92 now heads at `f7e62c8`; Frontend, Rust Linux, Rust Windows, and Portable Unicode CI all passed. Findings-first audit found no blocking/actionable issues; remaining notification/audio delivery risk is external OS/browser permission configuration and does not affect timer state.

- Reworked Pomodoro presentation into the main cat window: the standalone Pomodoro WebView, route, menu entry, and Tauri window definition were removed. The main window now renders a transparent `MM:SS` display below the Live2D model while preserving the existing state machine, persistence, notifications, sound, tray commands, and preference-window command protocol.
- Added persisted `displayEnabled` (default `true`) and `displayScale` (50-200%, default `100`) settings. Model scaling remains the base size; the timer area and full window height are calculated independently by `src/utils/pomodoroDisplay.ts`, and Live2D/Pixi now resize against the model area only.
- Added focused tests for display-setting sanitization, countdown formatting, aspect-ratio-preserving layout, relative timer scaling, and disabled-display window restoration.
- PR #92 remains open at head `02a6944` (`fix(pomodoro): restore coordinator command delivery`), is labeled `enhancement` and `windows`, received findings-first reviews with no blocking or actionable findings, and the original implementation CI passed all four jobs (Frontend, Rust Linux, Rust Windows, Portable Unicode smoke). No squash merge is performed.
- Follow-up fix: Pomodoro coordinator state snapshots now clone `toRaw` Pinia state instead of reactive proxies, which prevents coordinator startup failure and the resulting 15-second command timeout. The coordinator starts immediately after main app persistence initialization, before slow model scanning, and command acknowledgements target their source WebView.
- Follow-up verification: `pnpm test` 136/136, TypeScript, ESLint, Vite build, and all four CI jobs for head `02a6944` passed. PR #92 remains Open.

## Embedded Pomodoro Verification

- `pnpm test`: 135/135 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint src --max-warnings 1`: passed with one pre-existing UnoCSS ordering warning in `src/components/shortcut/index.vue:99`.
- `pnpm build:vite`: passed with existing third-party PURE annotation and bundle-size warnings.
- `cargo test --workspace --all-targets --locked`: 38/38 tests passed.
- `cargo check --workspace --all-targets --locked`: passed.
- Locale JSON parsing and `git diff --check`: passed.

- Fixed Tauri development startup ambiguity by selecting `mochi-paw` as the default Cargo binary.
- Verified Cargo metadata resolves `default_run` to `mochi-paw`.
- Verified `cargo check --no-default-features --bin mochi-paw` succeeds.
- Verified `pnpm tauri dev` reaches and launches `target/debug/mochi-paw.exe` without binary ambiguity.
- Added default-enabled daily typing statistics with local-date aggregation, privacy-preserving persisted state, and one-second sync/save throttling.
- Added a dedicated preferences page with today's total, a 30-day CSS trend chart, tracking controls, and confirmed history clearing in all five supported locales.
- Kept the main window as the only persistent statistics writer; preference-window toggle and clear requests use Tauri frontend events to avoid throttled whole-state write races.
- Updated the Wayland input relay so evdev auto-repeat value `2` is forwarded as another keyboard press.

## Typing Statistics Verification

- `pnpm test`: 45/45 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint src`: passed with one pre-existing UnoCSS ordering warning in `src/components/shortcut/index.vue:99`.
- `pnpm build:vite`: passed; only existing third-party PURE annotation and bundle-size warnings were reported.
- `cargo check --manifest-path src-tauri/Cargo.toml --features inputd --bin mochi-paw-inputd`: passed.
- `rustfmt --check --edition 2024 src-tauri/src/bin/mochi-paw-inputd.rs`: passed.
- Locale JSON parsing and `git diff --check`: passed.
- Tauri WebView screenshots at 900x650 and 800x600 showed no page-level horizontal overflow or overlapping labels.
- Real main/preference-window verification passed: persisted counts appeared in the preference window, disabling and re-enabling synchronized correctly, and confirmed clearing produced `{ enabled: true, dailyCounts: {} }`, updated the visible total to zero, and disabled the clear button.
- The synthetic development statistics file and visual-check artifacts were removed after verification.

## Remaining Baseline Notes

- `cargo fmt --all -- --check` still reports unrelated pre-existing formatting drift in several Rust files; the modified input relay file passes targeted rustfmt checking.
- `src-tauri/Cargo.toml` remains an existing user change and was not modified as part of the typing statistics implementation.

## Unicode Paths And Model Persistence

- Windows path joining now preserves drive and UNC roots while normalizing mixed separators without changing Unicode, spaces, `#`, or `%` characters.
- Rust directory copy and ZIP extraction use native paths internally; ZIP entries require reliable UTF-8 names and retain Zip Slip protection.
- Administrator relaunch keeps argv as native UTF-16, and the portable builder invokes the Tauri CLI with an argument array instead of a shell command string.
- Model selection is persisted as schema-v2 `currentModelId`; legacy full-model state migrates by ID and, only when explicitly pending, fingerprint.
- Model switching acknowledges success only after all model resources load, the stable ID reaches the Pinia backend, and `saveNow` completes. Failed switches restore both renderer state and the backend selection.
- Runtime model fields are excluded from persistence, submodel windows cannot write the model/cat/general stores, and user-initiated exit or restart paths flush stores immediately.
- Root or per-model catalog scan failures keep the existing persisted catalog instead of treating temporarily unreadable models as deleted.

## Unicode Persistence Verification

- `pnpm test`: 69/69 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint src --max-warnings 1`: passed with the pre-existing shortcut UnoCSS ordering warning.
- `pnpm build:vite`: passed with existing dependency annotation and bundle-size warnings.
- `cargo test --workspace --all-targets`: 16/16 tests passed.
- `cargo check --workspace --all-targets`: passed.
- Portable packaging with the direct Tauri CLI entry succeeded from the Unicode/space workspace; `tauri-cli 2.11.3` was resolved without a shell.
- `git diff --check`: passed; Git reported only the repository's CRLF conversion notices.

## Unicode Persistence Delivery

- Commit: `fix(model): support Unicode paths and persist selection`.
- PR: `CatStack-pixe/MochiPaw#78`, labeled `bug` and `windows` before review.
- Findings-first PR review completed with no blocking or actionable findings; the review records missing remote CI and the remaining full special-character portable build as residual test risks.
- PR #78 was squash-merged into `master`, and the remote feature branch was deleted.
- Existing typing statistics, input relay, locale, `default-run`, and handoff worktree changes remain outside the merged PR.

## Continuous Integration

- Added a read-only `CI` workflow for pull requests targeting `master`, pushes to `master`, and manual runs.
- Frontend CI uses Node 22, pnpm 10.17.1, a frozen lockfile, pnpm store caching, tests, TypeScript checking, a one-warning ESLint ceiling, Vite production build, and portable script syntax validation.
- Rust CI runs locked workspace tests and checks on Ubuntu 22.04 and Windows 2022; Linux also executes the `mochi-paw-inputd` test binary.
- Added a Windows portable smoke test that runs the real packaging script without `--skip-build` from a temporary Unicode/space/`#`/`%` path, then extracts the ZIP and compares executable and model-resource bytes.
- CI uses read-only repository permissions, per-PR/ref concurrency cancellation, fixed timeouts, and Rust/pnpm caches.

## CI Verification

- `pnpm install --frozen-lockfile --ignore-scripts`: passed without lockfile changes.
- `pnpm test`: 69/69 tests passed in the full preserved worktree.
- `pnpm exec tsc --noEmit`, `pnpm build:vite`, and `pnpm exec eslint src --max-warnings 1`: passed; ESLint reports only the existing shortcut ordering warning.
- `cargo test --workspace --all-targets --locked`: 16/16 tests passed.
- `cargo check --workspace --all-targets --locked`: passed.
- `scripts/testPortableUnicode.ps1`: passed under Windows PowerShell with native Chinese, space, `#`, and `%` paths.
- Workflow YAML parsing, YAML linting, and `git diff --check`: passed.

## CI Delivery

- PR `CatStack-pixe/MochiPaw#79` was labeled `enhancement` and `windows` before review.
- The first CI run exposed missing generated Tauri icons on clean Rust runners; both Rust jobs now install frontend dependencies and run `pnpm build:icon` before Cargo commands.
- A findings-first review found no blocking or actionable issues after the icon fix.
- PR #79 was squash-merged into `master` as `a3b3a39e4ed70a11ebddc39aa8570b7ba524bdb8`, and the remote feature branch was deleted.
- The post-merge `master` run `31301816421` passed all four jobs: Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke.
- Existing typing statistics, input relay, locale, `default-run`, and handoff worktree changes remain outside the merged PR.

## Typing Statistics And v1.1.9 Delivery

- Typing statistics now persist only `enabled` and per-day totals. Key names, typed content, and application sources are never stored.
- Main-window operations wait for store hydration and serialize input, preference changes, clearing, flushes, and rollback through a shared coordinator.
- Exit and restart flows use per-transaction pause tokens, explicitly patch and save the backend, and replay buffered inputs if saving or the process action fails.
- Linux evdev repeat value `2` is counted as another keyboard press.
- Release version updates now locate the Cargo package structurally, fail on missing or duplicate matches, and verify tag/package/manifest/lockfile agreement before bundling.
- PR #80 was labeled `enhancement` and `release`, received a findings-first review with no blocking or actionable findings, and was squash-merged as `2b0c2e0d1dd258bf48340944ba853e6ed386709a`.
- The first v1.1.9 tag run exposed an extra Tauri runner separator: Cargo received `-- --locked` and rejected the locked flag. The failed run was canceled before any release or assets were created.
- PR #81 fixed all five release matrix arguments, was labeled `bug` and `release`, passed review and all four CI jobs, and was squash-merged as `f85421d74701123bedf7f1ce6a9b09e8bdb5a823`.
- The unpublished `v1.1.9` tag was recreated on `f85421d74701123bedf7f1ce6a9b09e8bdb5a823`; release run `31310132177` passed all five platform jobs.
- [MochiPaw v1.1.9](https://github.com/CatStack-pixe/MochiPaw/releases/tag/v1.1.9) is public and latest with 13 verified macOS, Linux, Windows installer, and Windows portable assets.
- Release notes retain the v1.1.8 `## What's New` format and identify functionality from PRs #78, #79, #80, and #81.

## v1.1.9 Verification

- `pnpm test`: 88/88 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- Targeted and full ESLint checks passed with the single pre-existing UnoCSS ordering warning allowed by CI.
- `pnpm build:vite`: passed with existing dependency annotation and bundle-size warnings.
- `cargo test --workspace --all-targets --locked`: 16/16 Windows workspace tests passed; Linux CI also passed the two inputd tests.
- `cargo check --workspace --all-targets --locked`: passed locally and on Linux/Windows CI.
- `pnpm exec tsx scripts/checkReleaseVersion.ts v1.1.9`: passed.
- `pnpm tauri build --no-bundle -- -- --locked`: passed locally before the action-specific argument correction; the corrected action path was then proven by all five successful release jobs.
- PR #80, PR #81, both post-merge `master` runs, and the final v1.1.9 release matrix passed.
- All 13 public release assets are non-empty and report uploaded state.

## Remaining Release Note

- The post-publish UpgradeLink workflow run `31310800547` failed because repository UpgradeLink credentials are empty. Updater artifacts and `latest.json` signing remain disabled as in v1.1.8, so GitHub release downloads work but in-app automatic updating is not restored by v1.1.9.
- The pre-existing local `master` branch is two commits ahead of and 24 commits behind `origin/master`; a final fast-forward was intentionally refused, and no reset, rebase, or local-history rewrite was performed. Remote `master`, `v1.1.9`, and the public release all point to the intended published history.

## Persistent Store Recovery

- Diagnosed the reported model-switch failure `expected value at line 1 column 1` as an empty or malformed Pinia `model.json`; the model transaction correctly rolled back to `preset-gamepad`.
- Added startup validation for the `app`, `cat`, `general`, `model`, `shortcut`, and `typingStats` stores before configured webviews are created.
- Invalid store files are renamed to unique, timestamped backups in the same Pinia directory without changing their bytes. Missing and valid stores remain untouched, and failed backups leave the source file in place.
- Recovery follows the active Pinia collection path and the dependency's release/debug filename convention (`.json` / `.dev.json`).
- The preference window consumes a backend-enforced one-shot report and shows localized success, partial-failure, or failure details in all five supported languages; startup brings the normally hidden window forward when a report is pending so the warning cannot pass unseen.
- The recovery notice records backup paths and explains that custom names, behaviors, submodel settings, or typing statistics may reset while installed model directories remain discoverable.

## Persistent Store Recovery Verification

- `pnpm test`: 91/91 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint src --max-warnings 1`: passed with the single pre-existing shortcut ordering warning.
- `pnpm build:vite`: passed with existing dependency annotation and bundle-size warnings.
- `cargo test --workspace --all-targets --locked`: passed (18 main crate tests plus plugin/bin tests).
- `cargo check --workspace --all-targets --locked`: passed.
- Targeted Rust formatting, locale JSON parsing, and `git diff --check`: passed.
- Findings-first local review found no blocking or actionable issues.
- Residual risks: corrupt `meta.tauristore` remains outside the six-store recovery scope, and same-directory `rename` has a very small external no-clobber race on Unix despite single-instance startup and collision checks.

## Persistent Store Recovery Delivery

- Commit: `fix(store): recover corrupted persistent state`.
- PR [#82](https://github.com/CatStack-pixe/MochiPaw/pull/82) was labeled `bug` and `windows` before review.
- Findings-first review identified an unseen hidden-preference report path; startup now keeps an immutable attention marker and automatically shows/focuses Preferences whenever recovery needs user attention.
- The final exact head passed Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke CI, and three independent re-reviews found no remaining actionable issues.
- PR #82 was squash-merged into `master` as `f3953bbced97655399e90e2a5486ce596f5e8c70`, and the remote feature branch was deleted.
- Post-merge `master` CI run `31325287832` passed Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke.
- The published application version remains `1.1.9`; this post-release fix did not create or move a version tag or release.

## Signed Automatic Updates

- PR [#83](https://github.com/CatStack-pixe/MochiPaw/pull/83) replaced the failed UpgradeLink integration with Tauri's signed updater and project-owned GitHub Release metadata at `latest-v2.json`.
- Windows installer builds, macOS bundles, and Linux AppImages use native updates. Windows portable archives, DEB packages, RPM packages, and unknown distributions keep version checks but open the matching GitHub Release for manual installation.
- Windows portable archives now carry `.mochipaw-portable` beside the executable. The Unicode portable smoke test verifies the marker and verifies that it does not leak into normal installer staging.
- Update checks are shared across the interval, tray, and About page. Native installation runs download, persistent-store save, install, and non-Windows relaunch in order, with retryable failure handling and updater-resource cleanup.
- Release jobs sign all five targets, merge per-platform metadata, verify architectures, installer mappings, HTTPS URLs, signatures, and matching assets, then publish only after replacing `latest.json` with `latest-v2.json`.
- The active encrypted offline key backup is `E:\文件\Python Script\Mochi\MochiPaw-signing-backup\mochipaw-updater-v4.key` with its `.pub` file. The private key and password are stored only in GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; no private updater material is committed.
- Follow-up PRs [#84](https://github.com/CatStack-pixe/MochiPaw/pull/84), [#85](https://github.com/CatStack-pixe/MochiPaw/pull/85), and [#86](https://github.com/CatStack-pixe/MochiPaw/pull/86) corrected key upload encoding, added secret preflight validation, and made draft-release finalization use authenticated paginated lookup. Each PR was labeled before a findings-first audit and squash merge.
- Final review found and fixed release-asset URL matching, updater resource lifetime, and check/apply interleaving issues. The exact merged implementation passed 115 frontend tests, TypeScript, Vite, Rust tests/checks, locale/YAML/workflow checks, Unicode portable smoke, and `git diff --check`.

## Updater Preview Releases

- [v1.1.9-1](https://github.com/CatStack-pixe/MochiPaw/releases/tag/v1.1.9-1) and [v1.1.9-2](https://github.com/CatStack-pixe/MochiPaw/releases/tag/v1.1.9-2) are the corrected Pre-releases, following the repository's established suffix convention. Both have `## What's New` notes matching the established release format and explicitly require manual installation for testing.
- PR [#88](https://github.com/CatStack-pixe/MochiPaw/pull/88) was labeled `bug` and `release`, audited findings-first, and squash-merged as `6d9144373f8fcecf440802107267b18e128671ca`; release run `31392746070` built and finalized all five targets for v1.1.9-1.
- PR [#89](https://github.com/CatStack-pixe/MochiPaw/pull/89) was labeled `enhancement` and `release`, audited findings-first, and squash-merged as `1abce32187fc68795768046471c1f2c907463a4b`; release run `31395974654` built and finalized all five targets for v1.1.9-2.
- Each corrected preview has 24 uploaded assets, version-matched installer/package filenames, non-empty signatures, and `latest-v2.json` metadata with version-matched 15-platform mappings. The old incorrectly numbered v1.1.10 and v1.1.11 Releases and Tags were deleted after this verification.
- A temporary Windows v1.1.10 install discovered the then-current v1.1.11 preview and reached 87.67% of the signed download before the user stopped the install test. The registry entry, test process, and `C:\Program Files\MochiPaw` directory were removed; existing roaming configuration and models were not deleted.
- GitHub now reports v1.1.9 as Latest. Both stable updater endpoints, `latest-v2.json` and the legacy `latest.json`, return 404, so neither preview is offered to stable users. Future stable recovery releases must use a version higher than the deleted 1.1.10/1.1.11 builds (at least `1.1.12`) because the updater will not downgrade installed clients.
- `HANDOFF.md` is ignored by the root `/HANDOFF.md` rule and remains local only.

## Windows Game Mode

- Added a Windows-only game compatibility mode driven by a configurable executable-name list, defaulting to `VALORANT-Win64-Shipping.exe` and `VALORANT.exe`.
- The custom window plugin now polls running processes every two seconds, applies `WS_EX_NOACTIVATE` without replacing unrelated extended styles, keeps mouse passthrough synchronized, and emits `game-mode-changed` transitions.
- Replaced the previous 16 ms TOPMOST enforcement loop with single `SetWindowPos` calls using `SWP_NOACTIVATE`; active game mode temporarily removes TOPMOST and restores the latest user preference afterward.
- The Preferences UI persists the game-mode switch and process tags. The shortcut registry provides a configurable `Ctrl+Shift+G` default, and active mode caps main-model rendering at 30 FPS.
- DXGI injection and Present hooks remain explicitly out of scope. True exclusive fullscreen may hide the pet; acceptance is that the game retains focus and is not minimized or pushed to the background.

## Windows Game Mode Verification

- `pnpm test`: 115/115 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec eslint src --max-warnings 1`: passed with the single pre-existing UnoCSS ordering warning.
- `cargo check --manifest-path src-tauri/src/plugins/window/Cargo.toml --target x86_64-pc-windows-msvc`: passed.
- Full Vite build, workspace Rust checks, and workspace Rust tests passed in the final local validation pass. Live Valorant fullscreen verification remains pending a machine with the game installed.
- No commit, push, PR, label, review submission, or merge has been performed.

## v1.1.9-3 Local Windows Portable Package

- Updated the package, Rust application, and lockfile versions to `1.1.9-3`; `scripts/checkReleaseVersion.ts v1.1.9-3` passed.
- Built and verified `target/release/bundle/portable/MochiPaw_1.1.9-3_windows_x64_portable.zip` locally. The 8,887,980-byte archive contains `MochiPaw.exe`, `.mochipaw-portable`, and the bundled standard Live2D model resources.
- SHA-256: `FADCC605A353D40DE58830E25D04CAC679DE6121F426966D2E40E340CD6CE527`.
- No commit, push, PR, label, review submission, or merge has been performed.

## v1.1.9-3 Local Windows MSI

- Built and validated `target/release/bundle/msi/MochiPaw_1.1.9-3_x64_en-US.msi` locally.
- Windows Installer metadata reports product `MochiPaw`, version `1.1.9.3`, manufacturer `CatStack`, and upgrade code `{91E4BF84-4AAA-5558-B6D7-DD3AE9B7B879}`.
- The installer is 7,360,297 bytes with SHA-256 `A75640EB6ED727AF9CE2B342451F099E8DB50176832BE6ACB894B62F5B2A0481`.
- The local MSI is not Authenticode-signed. No installation was performed during validation.
- No commit, push, PR, label, review submission, or merge has been performed.

## v1.1.10 Windows Game Mode Delivery

- Version sources were updated to `1.1.10` in `package.json`, `src-tauri/Cargo.toml`, and `Cargo.lock`.
- PR [#90](https://github.com/CatStack-pixe/MochiPaw/pull/90) was labeled `enhancement`, `windows`, and `release`.
- Findings-first static audit completed with no blocking or actionable findings. The audit covered process polling, generation guards, Win32 style restoration, non-activating main-window display, non-Windows fallbacks, localization, shortcut wiring, and version consistency.
- The GitHub approval review could not be submitted because the PR author cannot approve their own pull request; this platform restriction did not prevent the audit or merge.
- PR #90 was squash-merged into `master` as `a97bf19ef5b6201a229db1b355f91c4f534a4674` after Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke CI passed.
- Tag `v1.1.10` points to `a97bf19ef5b6201a229db1b355f91c4f534a4674`; the public [MochiPaw v1.1.10](https://github.com/CatStack-pixe/MochiPaw/releases/tag/v1.1.10) Release is published with 24 uploaded assets, including signed Windows installers, a Windows portable archive, macOS Intel/Apple Silicon bundles, x86_64/AArch64 Linux packages, and `latest-v2.json` updater metadata.
- Release run `31689414733` passed all five platform builds and updater-metadata finalization. The PR CI run `31688851911` and post-merge master CI run `31689339083` also passed all four checks.
- Release notes follow the existing `## What's New` format and reference PRs #83, #85, #86, and #90. They include the v1.1.9-1/v1.1.9-2 updater-preview changes, the Windows-only Game Mode behavior, and the true exclusive-fullscreen limitation.
- Post-publication source audit found that the non-Windows no-op Game Mode command exposes underscore-prefixed IPC argument names while the frontend sends unprefixed names. This does not affect Windows Game Mode or the v1.1.10 release assets, but can emit a recoverable initialization error on Linux/macOS and should be corrected in the next patch release.

## v1.1.10 Download Package Organization

- Organized downloaded v1.1.10 artifacts under `C:\Users\LEGION\Downloads\MochiPaw` using `Windows`, `Linux`, and `MacOS` platform folders to match the Quark share layout reference.
- Kept `MochiPaw_1.1.10_windows_x64_portable.zip` at the root for direct Windows portable downloads and added a root-level Chinese TXT instruction file.
- The initially missing `MochiPaw_1.1.10_x64.app.tar.gz.sig` and `latest-v2.json` files were downloaded later and placed in `MacOS` and the package root respectively. All 24 GitHub Release assets are now present and non-empty, alongside the reference screenshot and portable-download TXT instruction.

## Repository Status Audit (2026-08-13)

- The active local branch is `chore/release-v1.1.9-2` at `78458b7`; its matching remote branch was deleted after PR #89 was squash-merged.
- The local branch had no unpushed commits relative to its remote-tracking ref. After `git fetch origin --prune`, `origin/chore/release-v1.1.9-2` is correctly marked gone.
- GitHub repository: `CatStack-pixe/MochiPaw`; `master` points to `1abce32187fc68795768046471c1f2c907463a4b` (PR #89 merge commit). PR #89 is merged, and no open PRs are listed in this repository.
- GitHub releases: `v1.1.9` remains Latest; `v1.1.9-1` and `v1.1.9-2` are successful Pre-releases. Recent release and post-merge Actions runs are successful.
- The local worktree contains 20 modified tracked files, with 648 insertions and 120 deletions; there are no untracked files. These changes are not committed or pushed.
- Local `master` remains divergent from `origin/master` (1 local-only commit and 1 remote-only commit); no history rewrite or synchronization was performed.

## v1.1.10 Delivery

- PR [#90](https://github.com/CatStack-pixe/MochiPaw/pull/90) introduced the Windows game compatibility mode, was categorized with `enhancement`, `release`, and `windows`, then squash-merged as `a97bf19ef5b6201a229db1b355f91c4f534a4674`.
- The release tag `v1.1.10` points to that exact squash-merge commit. Release run `31689414733` completed successfully across both macOS targets, both Linux targets, Windows, and the updater-metadata finalization job.
- The published release has signed installer/application assets for Windows, macOS, and Linux, plus the Windows portable archive and `latest-v2.json` updater metadata.
- Final findings-first audit: no blocking or actionable findings. The remaining test risk is live exclusive-fullscreen verification with a real configured game process, which was not available on the validation machine.

## Mouse Pass-Through Regression (2026-08-13)

- Updated `useDevice` hover-hide transitions so the main window uses the custom `setPassThrough` command on Windows; macOS and Linux retain Tauri's native cursor-event API.
- Entering the window still temporarily enables pass-through while hiding the model; leaving restores the persisted Cat Lock value without changing settings state.
- Verification passed: `pnpm exec tsc --noEmit --pretty false`, `pnpm test` (115/115), focused ESLint for `useDevice`, `cargo test --manifest-path src-tauri/src/plugins/window/Cargo.toml --locked` (4/4), `cargo check --manifest-path src-tauri/src/plugins/window/Cargo.toml --target x86_64-pc-windows-msvc --locked`, and `git diff --check`.
- Manual Windows interaction verification remains pending: test Cat Lock before and after a hide-on-hover enter/leave cycle, then confirm disabling Cat Lock restores interaction.
- This fix is intentionally local only. No commit, push, PR, label, review submission, merge, tag, or release was performed.

## v1.1.10-1 Pre-release In Progress (2026-08-13)

- Preparing a prerelease that contains the Windows hover-hide Cat Lock regression fix.
- Version sources are set to `1.1.10-1`; the release workflow will mark tag `v1.1.10-1` as a GitHub Pre-release.
- Because `1.1.10-1` sorts below stable `1.1.10`, this preview must be installed manually and will not be offered as an upgrade to stable clients.
- Local verification passed: 115/115 frontend tests, TypeScript, Vite production build, ESLint with the single pre-existing UnoCSS ordering warning, 38/38 workspace Rust tests, workspace Rust check, 4/4 custom-window plugin tests, Windows-target plugin check, release-version validation, and `git diff --check`.

## v1.1.10-1 Pre-release Delivered (2026-08-13)

- Commit `59f8dd8` was pushed in branch `fix/mouse-pass-through-v1.1.10-1`; PR #91 was labeled `bug`, `windows`, and `release`, audited findings-first with no blocking or actionable findings, and squash-merged as `a01fdd1437ee4769558e2331852d5324f9e69ca2`.
- Post-merge master CI run `31716059079` passed Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke.
- Annotated tag `v1.1.10-1` points to the squash merge and triggered release run `31716631076`; all five platform build jobs and updater metadata publication passed.
- GitHub Release [MochiPaw v1.1.10-1](https://github.com/CatStack-pixe/MochiPaw/releases/tag/v1.1.10-1) is public and marked Pre-release with 24 non-empty uploaded assets, one `latest-v2.json`, and no legacy `latest.json`.
- Release notes explain the Windows Cat Lock hover-hide fix and manual-install testing steps. The remaining verification item is hands-on Windows interaction testing with Game Mode disabled.
- No additional source changes, commits, PRs, tags, or releases were made after publication.

## Pomodoro Timer (2026-08-15)

- Added a main-window-owned Pomodoro state machine with focus, short-break, and long-break phases; absolute `endAt` timestamps preserve accuracy across sleep, hidden windows, and restart recovery.
- Added persisted settings/runtime state, today's completed count, pause/resume/reset/skip/settings commands, cross-window request/ack events, and an on-demand always-on-top `pomodoro` window.
- Added Preferences controls, tray/context-menu actions, localized copy in all five supported locales, system notifications with permission fallback, and a short completion tone.
- Added deterministic clock/store tests. Local verification: 125/125 frontend tests, TypeScript, Vite production build, workspace Rust tests/check, targeted ESLint, and `git diff --check` passed; the only full ESLint output is the pre-existing shortcut UnoCSS ordering warning.
- Delivery is intentionally pending PR creation and CI; no merge has been performed.
- PR [#92](https://github.com/CatStack-pixe/MochiPaw/pull/92) was created from `feat/pomodoro-timer`, labeled `enhancement` and `windows`, and received a findings-first audit with no blocking or actionable findings.
- PR #92 CI passed Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke. The PR remains open by request; no approval merge or squash merge was performed.

## PR #92 Description Formatting (2026-08-16)

- Rewrote PR #92's description with the repository's established Markdown style: blank lines after headings, capitalized summary bullets, and backtick-formatted commands.
- Fixed the root cause of the formatting issue: the original body contained literal `\\n` sequences instead of real line breaks.
- Preserved the existing Pomodoro scope, verification results, `enhancement`/`windows` labels, findings-first audit, and the requirement that the PR remain open without merging.
- Confirmed the updated body through `gh pr view 92 --repo CatStack-pixe/MochiPaw --json body`; no source code, commits, pushes, reviews, or merges were performed.

## Mouse Follow Sensitivity (2026-08-16)

- Added a persisted global `mouseSensitivity` model setting with a `0-200%` slider/input in Cat preferences; `100%` preserves the previous behavior.
- Applied sensitivity around the normalized screen center for both absolute cursor tracking and Wayland relative movement, without changing system pointer speed, click input, Cat Lock, or hover hiding.
- Added defensive normalization for missing, malformed, negative, and over-range persisted values; legacy configurations default to `100%`.
- Added localized labels and hints in all five supported locales plus deterministic helper tests for identity, zero, amplification, clamping, and malformed values.
- Verification passed: `pnpm test` (130/130), `pnpm exec tsc --noEmit --pretty false`, `pnpm exec eslint src --max-warnings 1` (one pre-existing warning), `pnpm build:vite`, `cargo test --workspace --all-targets --locked` (38/38), `cargo check --workspace --all-targets --locked`, locale JSON parsing, and `git diff --check`.

## Mouse Sensitivity PR Delivery (2026-08-16)

- Commit `ca5daad` (`feat(cat): add mouse follow sensitivity`) was pushed to the existing `feat/pomodoro-timer` branch.
- PR [#92](https://github.com/CatStack-pixe/MochiPaw/pull/92) now uses the title `feat(cat): add Pomodoro timer and mouse sensitivity` and an updated, correctly formatted description with the new verification totals.
- Existing `enhancement` and `windows` labels were retained before the findings-first audit. The audit found no blocking or actionable issues; the PR remains open and must not be merged for this task.
- CI run `31923504612` passed Frontend, Rust Linux, Rust Windows, and Portable Unicode smoke for commit `ca5daad`; PR #92 remains open and unmerged.

## v1.2.0 Download Package Organization (2026-08-17)

- Replaced the downloaded `1.1.10` release package set in `C:\Users\LEGION\Downloads\MochiPaw` with the complete `1.2.0` set, preserving the existing `Linux`, `MacOS`, `Windows`, and per-platform `sig` directory layout.
- Replaced the root `latest-v2.json` with the `1.2.0` updater metadata and updated the Windows portable-download instruction to reference `MochiPaw我是便携版.zip`.
- Replaced the extracted portable application at `C:\Users\LEGION\Downloads\MochiPaw\MochiPaw\MochiPaw` only after staging and validating the new archive. The old extracted directory contained no user configuration or data files.
- Verification confirmed updater metadata version `1.2.0`, portable executable version `1.2.0`, 6 Linux packages plus 6 signatures, 4 macOS packages plus 2 signatures, 3 Windows packages plus 2 signatures, no remaining `1.1.10` files, and matching SHA-256 hashes for the two portable ZIP copies.
- No source-code commit, push, PR, review, or merge was performed for this download-directory maintenance task.

## Windows Unfocused Game Rendering Diagnostics (2026-08-17)

- Removed the Game Mode `30 FPS` clamp. Game Mode now preserves the user's configured maximum render frame rate while continuing to manage Windows activation and pass-through behavior.
- Kept visible main, sub-model, and other animated windows at the WebView2 Normal memory target during idle periods. Hidden windows still switch to Low immediately, while the Preferences window retains its existing visible-idle memory reduction.
- Added full event diagnostics for window focus/visibility, Game Mode configuration and active-state changes, WebView2 memory-target decisions/results, Pixi ticker start/stop reasons, rendering state, and configured/effective FPS.
- Added once-per-second render aggregation without per-frame file writes. Reports include actual FPS, Pixi ticker delta statistics, observed wall-clock frame intervals, long-frame counts, target FPS, focus/visibility state, model presence, and ticker state.
- Added deterministic tests for Game Mode FPS policy, visible animation-window memory policy, 60 FPS aggregation, observed frame intervals, long frames, and invalid ticker deltas.
- Verification passed: `pnpm test` (153/153), `pnpm exec tsc --noEmit --pretty false`, `pnpm exec eslint src --max-warnings 1` (the single pre-existing UnoCSS ordering warning remains), `pnpm build:vite`, `cargo test --workspace --all-targets --locked` (38/38), `cargo check --workspace --all-targets --locked`, and `git diff --check`.
- Findings-first audit found no blocking or actionable issues. Manual Windows validation with a configured foreground game remains pending; if aggregated logs still show WebView2 background throttling, evaluate Chromium/WebView2 background-rendering flags as a separate follow-up.
- Changes remain local. No commit, push, PR, label, review submission, merge, tag, or release was performed.

## v1.2.0-1 Local Windows MSI (2026-08-17)

- Updated `package.json`, `src-tauri/Cargo.toml`, and the `mochi-paw` package entry in `Cargo.lock` from `1.2.0` to `1.2.0-1`; `pnpm exec tsx scripts/checkReleaseVersion.ts v1.2.0-1` passed.
- Built the x64 Windows MSI with the current local unfocused-rendering fixes using `pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi -- -- --locked`.
- The MSI was successfully produced at `target/x86_64-pc-windows-msvc/release/bundle/msi/MochiPaw_1.2.0-1_x64_en-US.msi` and copied to `C:\Users\LEGION\Downloads\MochiPaw_1.2.0-1_x64_en-US.msi`.
- Windows Installer metadata reports product `MochiPaw`, version `1.2.0.1`, manufacturer `CatStack`, product code `{09607485-73C2-4666-BD90-E3071866D8C3}`, and upgrade code `{91E4BF84-4AAA-5558-B6D7-DD3AE9B7B879}`.
- The MSI is 7,438,121 bytes with SHA-256 `49711FA22266F333E87DC91AE44AE1468710C5BE2A8403F9CE71FCCF031C3C6E`.
- The bundle is not Authenticode-signed. Tauri completed the MSI before returning a signing-stage error because the repository has an updater public key but this machine does not have `TAURI_SIGNING_PRIVATE_KEY`.
- No installation, commit, push, PR, label, review submission, merge, tag, or release was performed.

## v1.2.0 Typing Statistics Exit/Restart Recovery (2026-08-17)

- Investigated `C:\Users\LEGION\Downloads\MochiPaw (3).log`; the log reports `1.2.0-1` and shows a terminal-action overlap at `17:16:13` followed by a typing-statistics timeout at `17:16:40`.
- Added request-level diagnostics with request ID, operation, source, timeout, window visibility/focus, acknowledgement, dispatch failure, timeout, and listener cleanup details.
- Added persistence-stage diagnostics covering typing-statistics hydration, backend patch/save, flush, store save, recovery, terminal action invocation, and gate release.
- Added a 10-second timeout around the main-window typing statistics patch/save sequence so a stalled store backend returns a recoverable error before the outer 15-second request timeout.
- Made concurrent exit/restart calls reuse the in-flight terminal action instead of throwing an unhandled duplicate-action error. Failed saves still attempt to resume typing input and preserve the original error.
- Added regression tests proving concurrent terminal actions execute only the first action and stalled typing-statistics persistence times out; all existing typing-statistics and persistence tests remain passing.
- Verification: `pnpm test` (155/155), `pnpm exec tsc --noEmit --pretty false`, `pnpm exec eslint src --max-warnings 1` (one pre-existing UnoCSS warning), and `git diff --check` passed.
- Rebuilt the x64 MSI with the persistence fixes at `target/x86_64-pc-windows-msvc/release/bundle/msi/MochiPaw_1.2.0-1_x64_en-US.msi` and copied it to `C:\Users\LEGION\Downloads\MochiPaw_1.2.0-1_x64_en-US.msi`; size is 7,438,121 bytes and SHA-256 is `51205983B19D9E753B3849971A1C718B5FFE5B9FF91FB686CB8C15DA42CDCCD9`.
- `pnpm build:vite` and `cargo check --workspace --all-targets --locked` passed. MSI bundling completed; the command returned a signing-stage error because `TAURI_SIGNING_PRIVATE_KEY` is not configured, so the MSI is unsigned.
- Changes remain local. No commit, push, PR, review submission, merge, tag, or release was performed.

## Render Diagnostic Log 4 Analysis (2026-08-17)

- Inspected `C:\Users\LEGION\Downloads\MochiPaw (4).log`; it contains 47 Live2D render summaries and no errors, warnings, typing-statistics operations, persistence operations, or terminal actions.
- While the main window was visible and unfocused, rendering fell from 74.7 FPS to 2.6 and 2.2 FPS, with individual observed frame gaps of 1003.2 ms and 829.3 ms. The Pixi ticker remained started and the model remained loaded throughout.
- A main-window focus event at `18:11:46` woke rendering. From `18:11:47` through `18:12:29`, rendering stayed at approximately 107-110 FPS with no long frames even though the main window was again unfocused.
- This is evidence of transient WebView2/Chromium background or occlusion scheduling rather than a stopped Pixi ticker, unloaded model, persistence deadlock, or sustained application freeze.
- The log references frontend asset `index-C9aSaGdW.js`; the final rebuilt MSI uses `index-CgfAyQdZ.js`, so this run did not use the latest MSI containing the final typing-statistics persistence timeout changes.
## Windows WebView2 强制关闭后台节流 (2026-08-17)

- 用户明确要求强制关闭失焦/游戏遮挡时的 WebView2 渲染节流。
- `src-tauri/tauri.conf.json` 的 `main` 与 `preference` 窗口加入 `additionalBrowserArgs`：
  `--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`，并禁用 `CalculateNativeWinOcclusion`；保留 Tauri 默认的 WebView2 feature 禁用项。
- `src-tauri/src/lib.rs` 在 Tauri 创建 WebView 前设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，覆盖运行时动态创建的 sub-model 窗口。
- 这是 Windows 专用的浏览器运行参数，目的是让渲染在失焦、被游戏遮挡时仍保持调度；代价是更高的后台 CPU/GPU/功耗，属于用户明确要求的强制策略。
- 已通过 `pnpm test` (155/155)、`pnpm exec tsc --noEmit --pretty false`、`cargo check --workspace --all-targets --locked`。
