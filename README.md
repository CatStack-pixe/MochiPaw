# MochiPaw

[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue)](./LICENSE)

MochiPaw is a Tauri + Vue desktop pet app based on
[BongoCat](https://github.com/ayangweb/BongoCat).

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
See [NOTICE.md](./NOTICE.md) for additional terms, core usage rules, and commercial licensing information.

> **Noncommercial only.** Commercial use requires prior written permission from CatStack / InfinityXCat.

## Features

- Desktop Live2D pet with transparent always-on-top window.
- Keyboard, gamepad, and standard preset model modes.
- Model import and management.
- Tray menu, preferences window, autostart, shortcuts, and update entry points.
- Windows administrator status and process metrics helpers.

## Requirements

- Node.js 22 or newer
- pnpm
- Rust stable toolchain
- Tauri desktop build prerequisites for your OS

Install dependencies:

```bash
pnpm install
```

## Development

Start the Tauri development app:

```bash
pnpm tauri dev
```

Start only the Vite dev server:

```bash
pnpm dev:vite
```

Generate app icons:

```bash
pnpm build:icon
```

## Build

Build only the frontend:

```bash
pnpm build:vite
```

Build frontend and regenerate icons:

```bash
pnpm build
```

Build the Tauri app for the current platform:

```bash
pnpm tauri build
```

Release builds cover Windows, macOS, and Linux:

```text
Windows: target/release/bundle/msi/ and target/release/bundle/nsis/
macOS:   target/release/bundle/dmg/ and target/release/bundle/macos/
Linux:   target/release/bundle/appimage/, target/release/bundle/deb/, and target/release/bundle/rpm/
```

## Portable Zip

Build a portable Windows zip:

```bash
pnpm build:portable
```

The archive is written to:

```text
target/release/bundle/portable/MochiPaw_<version>_windows_<arch>_portable.zip
```

If a release executable already exists and you only want to recreate the zip:

```bash
node scripts/packagePortable.mjs --skip-build
```

## Checks

```bash
pnpm lint
cargo check -p mochi-paw
cargo check -p tauri-plugin-admin-status
```

## Release

GitHub Releases are the public release channel for MochiPaw builds.

```bash
pnpm release
```

The release script syncs package metadata through `scripts/release.ts` and uses
`release-it`.

## License

MochiPaw original code and CatStack-maintained modifications are licensed under
the PolyForm Noncommercial License 1.0.0. Commercial use, paid distribution,
resale, monetized hosting, or integration into paid products or services
requires prior written permission from CatStack / InfinityXCat.

See [LICENSE](./LICENSE).

## Attribution

MochiPaw is a derivative work of
[ayangweb/BongoCat](https://github.com/ayangweb/BongoCat), which was released
under the MIT License.

The original MIT notice is retained in [NOTICE.md](./NOTICE.md). CatStack
changes are licensed under the noncommercial MochiPaw license unless a file
states otherwise.

Bundled Live2D/Cubism runtime and model assets keep their original upstream
terms. If you redistribute modified builds, review the asset and runtime
licenses for your distribution channel.
