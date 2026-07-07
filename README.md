# MochiPaw

MochiPaw is a Tauri + Vue desktop pet app based on
[BongoCat](https://github.com/ayangweb/BongoCat).

This repository is source-available for personal, research, learning, and
other noncommercial use. Commercial use is not permitted without prior written
permission from CatStack / InfinityXCat.

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

Build the Tauri app:

```bash
pnpm tauri build
```

Current Windows installer output is configured as MSI:

```text
target/release/bundle/msi/
```

## Portable Zip

Build a portable Windows zip:

```bash
pnpm package:portable
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
