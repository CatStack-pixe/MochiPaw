# Windows data layout

Windows installer and portable builds use the same application-owned data root:
`<directory containing the executable>/data`. The current working directory and
the `.mochipaw-portable` update-distribution marker do not change this rule.
macOS and Linux retain their existing platform-specific storage behavior.

```text
MochiPaw/
  MochiPaw.exe
  assets/                    bundled, read-only application resources
  data/
    layout.json              data layout identifier and version
    pinia/                   settings and store migration metadata
    custom-models/           imported models, grouped by stable model ID
    model-imports/           temporary model extraction directories
    logs/                    startup, application, and crash logs
    webview/                 shared WebView2 user data for all windows
```

## Layout version 1

`data/layout.json` contains exactly these fields:

```json
{
  "format": "mochipaw-data",
  "version": 1
}
```

This version describes the directory layout. It is independent of the app
release version and the schemas inside each Pinia store. A missing manifest is
initialized after the application verifies the required directories are
writable. An existing malformed or unsupported manifest stops startup without
overwriting it. Existing files within a supported local layout are preserved.

Settings continue to use the existing JSON store format. The `app`, `cat`,
`general`, `model`, `pomodoro`, `shortcut`, and `typingStats` stores live under
`data/pinia`. Collection metadata, including store migration history, also
stays there; a previously saved absolute collection path never overrides the
explicit directory selected by this Windows build. Debug stores and their
metadata retain their existing development filename suffixes.

## Fresh local data only

This change does not import old data. It does not read, copy, rename, or delete
anything under `%APPDATA%/com.CatStack.MochiPaw`, nor does it fall back to those
settings when the local root is absent or unusable. An upgrade from a build that
used Roaming starts with the default settings and bundled models until models
are imported into the new root. The old files remain available for a future,
separately implemented migration.

The application validates storage before opening persistent stores or creating
webviews. All initial windows and dynamically created sub-model windows use
the same `data/webview` directory. A storage error is reported in a native dialog
before the desktop pet window is created.

## Installation and portability

Windows MSI and EXE installers prepare the `data` directory for the account that
will use the app, including installations under `Program Files`. Installation
grants that account inheritable Modify access to `data` and repairs access to its
existing files and subdirectories. The installation directory, executable, and
bundled resources retain their original permissions. The app then starts and
saves settings with ordinary user permissions.

MSI uses the identity of the user who initiated installation. Interactive EXE
installation uses the desktop user when elevated, including when another
administrator supplies credentials for UAC. Start the installer from the desktop
of the account that will run the app. For an unattended EXE installation without
a desktop, specify that account's SID with `/MOCHIPAW_USER_SID=S-1-...`; permission
setup fails if the intended account is unspecified or its identity is unavailable.

Upgrading or repairing the installation at the same location repeats permission
setup and preserves existing settings and models. If an older installer reports
`Access denied (os error 5)` for `Program Files/MochiPaw/data`, install the updated
package over that installation. Custom deny rules continue to apply; the installer
adds the intended user's access while retaining the existing ACL. Close running
copies of the app before installation so its data files are available for repair.
Directory links and hard-linked files in an existing data tree must be resolved
before permission repair; the installer reports failure instead of changing the
linked destination's permissions.

Portable archives still require an extraction directory writable by the account
running the app. Separate Windows accounts should use separate installations if
they need separate settings. The data location remains beside the executable;
normal startup uses the same local data and requires no automatic elevation.

Close the app before moving or backing up its entire folder. Keep `data` beside
the executable. Pinia resolves its directory from the new executable location;
model discovery refreshes imported model paths using their stable directory
IDs. Main-model selection and sub-model instances keep their model IDs.
Bundled model paths are rebuilt from the current application resources.

Updating application binaries should preserve `data`. Portable release archives
contain application resources, not the developer's data directory. No data is
automatically removed by this layout change.

This rule covers application-owned filesystem data. OS-managed credentials,
autostart registration, installed WebView2 binaries, and installer/updater
temporary files remain managed by their respective system components. Moving
the application folder to another computer does not transfer OS credentials.

The layout change is independent of the invisible-window input-blocking report;
it does not by itself establish a fix for that issue.
