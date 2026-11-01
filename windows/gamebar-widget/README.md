# MochiPaw Game Bar overlay

This directory contains the packaged Xbox Game Bar widget and the current-user
full-trust bridge used by the desktop Tauri app.

## Runtime flow

1. The Tauri app detects the foreground target process/window.
2. In **Desktop** mode, it positions its transparent, click-through pet window
   over a matching windowed or borderless game and restores its prior frame
   when the game is no longer active.
3. In **Xbox Game Bar** mode, the app sends versioned state over the
   `MochiPaw.GameBarOverlay` named pipe. The packaged bridge restricts that pipe
   to the current Windows user and forwards requests to the widget's
   `com.catstack.mochipaw.overlay` AppService. Game Bar hosts the transparent
   Live2D widget, including for pinned fullscreen use.
4. The widget reads overlay state from package-local settings, pauses rendering
   when it is not visible or the configured game is not foreground, and applies
   the selected 60/90/120 FPS cap. The page reports its measured render rate;
   Game Bar scheduling and the display may keep actual FPS below that cap.

No game-process injection, DLL loading, graphics hooks, or game-memory access is
used.

## Models and controls

The widget contains a production Pixi/WebGL Live2D page, motion and expression
controls, and three bundled modes (`standard`, `keyboard`, `gamepad`). Those
three packaged model folders are selected by the current model's mode. Custom
imported model files are not currently streamed into the separately packaged
widget.

FPS and backend selection are configured in MochiPaw preferences. The widget's
input behavior is controlled by Game Bar's own pin/click-through UI; the
desktop pet's pass-through setting does not override Game Bar's input mode.

## Build and package

Requirements:

- Windows 10/11 and Windows 10 SDK 10.0.19041 or newer
- Visual Studio with the **Universal Windows Platform development** workload
  and MSBuild/XAML targets
- Node/pnpm and .NET 8 SDK
- A signing certificate whose publisher matches `CN=CatStack` for sideload
  installation (the generated package is unsigned by default)

Run:

```text
pnpm package:gamebar-widget
```

The script builds the Vite Live2D page, copies its three preset asset folders,
publishes the self-contained bridge, then invokes Visual Studio MSBuild to
produce the `.appx` package under `windows/gamebar-widget/GameBar/Packages/`.
Generated web assets, bridge binaries, and package outputs are ignored by Git.
To use a specific Visual Studio installation, set `MSBUILD_EXE` to its
`MSBuild.exe` path.

## Validation status

The frontend, Rust window plugin, and standalone bridge build on the current
development machine. The machine does not have the Visual Studio UWP/XAML
targets, so the actual UWP/MSIX project cannot compile or install here. The
manifest and project/XAML files can be parsed, but a Windows machine with the
required workload and a matching signing certificate must still build, install,
and exercise the widget through `Win+G`, pinning, fullscreen, and Game Bar's
click-through mode before release.
