# RAM and GPU validation

Use release artifacts from the same GitHub Actions workflow for the baseline and
candidate. Local compilation and automated tests are intentionally not required.
Run the two builds separately with the same model files, window sizes, frame-rate
settings, monitor scaling, operating system, and graphics driver. Record the
commit, artifact name, WebView runtime version, and whether hardware acceleration
is enabled. Keep developer tools closed during resource measurements.

## Interpret the counters correctly

On Windows, About reports both the Rust main process and a group consisting of
that process plus its verified `msedgewebview2.exe` descendants. It takes a process
snapshot, follows only WebView child links, checks creation times against their
parents, and rejects samples where a child PID changed after snapshot collection
began. Other applications' WebView processes and native helper processes are not
included. This is a process-tree measurement, not an attribution of every process
using a shared WebView user data folder. Compare the recorded process count with
Process Explorer before relying on a baseline. Orphaned or externally hosted
WebViews are outside this counter's scope.

- **Working-set sum** includes shared pages in each process. It is not unique
  physical RAM consumption and should not be compared to Task Manager's default
  private-working-set column.
- **Private commit** sums `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`. It measures
  committed private memory, including pages that are not currently resident; it
  is not the size of the virtual address space and is not GPU memory.
- CPU, threads, uptime, and PID remain **main-process-only** metrics. The historical
  `virtualMemoryBytes` IPC name is retained, but its UI label is private commit.
- An unsupported platform or incomplete group sample displays `--` (`null` in
  IPC), not a fabricated zero. A process exiting during collection can make one
  group sample unavailable; the next visible-page refresh retries it.
- The working-set trim button affects **only the main process**. It does not
  release Live2D textures or JavaScript objects and is not a leak fix. Do not use
  it during comparisons: paging resident memory out biases the reading.

See Microsoft's [memory counter definitions](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)
and [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model).

## Capture RAM and GPU separately

Use Process Explorer's process tree on Windows and include the application root
and its WebView2 browser, renderer, GPU, and utility processes. Add Working Set,
Private Bytes, CPU, GPU Usage, GPU Dedicated Bytes, and GPU Shared Bytes columns.
GPU process RAM and dedicated/shared GPU allocations are different measurements;
record the latter separately without adding them to the RAM working-set total.
Do not label adapter-wide GPU usage as this application's usage. Use Activity
Monitor/Instruments on macOS and process/GPU tooling appropriate to the Linux
driver when testing those platforms; the Windows-only app counters stay blank.

The submodel capacity estimate inspects image headers without decoding or reading
whole textures over IPC: PNG/WebP use 32 bytes; JPEG reads in chunks of at most
256 KiB and stops after finding dimensions or reaching 1 MiB. Unknown or unusually
large headers retain the existing file-size fallback, so this remains a capacity
estimate rather than measured resident memory. Concurrent requests for the same
model share one scan; completed metrics retain at most 64 models per WebView.

To sample the normal desktop-pet state, close Settings and use external tools.
The About page itself requires a Settings renderer and periodically samples
processes; keeping it open changes the state being measured.

## Scenarios and acceptance

For each build, repeat these scenarios at least three times. Record median RAM,
private commit, dedicated/shared GPU allocation, GPU utilization, and observed
frame rate over a 60-second settled interval rather than a single reading.

| Scenario | Check |
| --- | --- |
| Start one pet; leave Settings closed for 60 seconds | Compare settled process count, RAM, GPU allocation, frame rate, and CPU/GPU utilization. |
| Open and close Settings 20 times | The Settings renderer is released; settled memory does not grow monotonically after warm-up. |
| Browse every model-preview page 20 times | Only the intended active preview animates; old models, textures, and WebGL contexts are released. |
| Switch models rapidly and close during a pending load | Late loads are released, and reopening displays a usable model. |
| Hide/show the pet and minimize/restore Settings | Hidden views stop rendering; restoring resumes animation and input without stale timing jumps. |
| Move between 100%, 150%, and 200% DPI displays | The rendering resolution follows the configured cap, and pointer hit-testing remains aligned. |
| Repeat with multiple pets and a large custom texture model | Each live instance remains usable, and closing it releases its resources. |
| Never open Settings after startup | Tray actions, automatic updates, system theme changes, and submodel position/visibility persistence still work. |
| Reopen Settings while its previous close is saving | The new open request keeps or recreates a usable window. |
| Close or navigate during import/delete/model switch/submodel creation/update download | The active transaction is preserved. |
| Simulate a Settings persistence failure | Settings remains available and the unsaved state is retained. |

Warm-up allocations and browser/driver caches can stabilize above the first
sample. Confirm a suspected leak by repeating the same settled state over several
batches; retain a timeline and process list instead of imposing a universal RAM
threshold. Any claimed percentage improvement must reference measured baseline
and candidate values. Automated CI checks validate correctness, not RAM or GPU
performance on an interactive desktop.

## Automated coverage

Run compilation, type checks, linting, and regression tests in GitHub Actions.
The admin-status unit tests cover nested WebView membership, exclusion of foreign
WebViews and native helpers, duplicate entries, stale parent PIDs, PID reuse after
snapshot start, unreadable/exited children, and the root-only case. Include a
Windows build to type-check the native API calls; non-Windows builds verify that
unsupported counters retain their nullable contract.

The frontend job also runs a Chromium/SwiftShader browser smoke test against the
bundled Live2D model. It checks deferred Core loading, nonempty rendered pixels,
ten load/destroy cycles, actual GPU texture deletion, and cancellation before
readiness. The uploaded artifact contains results and the rendered model image.
Software rendering verifies resource ownership and output, not physical GPU
performance. Recovery from arbitrary external WebGL context loss is outside this
change and remains a separate compatibility check.

## Defaults and expected mechanisms

- Settings is created on demand and destroyed after its writable stores flush.
- Model cards use static covers; at most one visible, active card renders at
  24 FPS and a maximum pixel ratio of 1. Leaving the viewport releases it.
- Balanced quality caps desktop-pet rendering at pixel ratio 2; Economy caps at
  1, while Native preserves monitor density. The setting applies to all pets.
  Original model texture resolution and mipmaps are preserved in every mode.
- Hidden pets pause their ticker and reset animation timing on resume. Input and
  persistence continue in the main window.
- Core loads on first model use in each WebView. It stays resident after loading;
  destroying that WebView releases its environment.
