# BongoCat

BongoCat is a Tauri + Vue desktop pet application.

## Requirements

- Node.js 22 or newer
- pnpm
- Rust stable toolchain
- Windows build tools for Tauri desktop builds

Install frontend dependencies:

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

Generate app icons from `src-tauri/assets/logo.png` or `logo-mac.png`:

```bash
pnpm build:icon
```

## Build Commands

Build only the frontend into `dist/`:

```bash
pnpm build:vite
```

Build frontend and regenerate icons:

```bash
pnpm build
```

Build the Tauri app with the configured installer target:

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

The portable archive is written to:

```text
target/release/bundle/portable/BongoCat_<version>_windows_<arch>_portable.zip
```

The zip contains `BongoCat.exe` and bundled resources such as preset models and tray assets.

If a release executable already exists and you only want to recreate the zip:

```bash
node scripts/packagePortable.mjs --skip-build
```

## Clean Build Outputs

Generated build outputs are ignored by git and can be deleted when needed:

```powershell
Remove-Item -Recurse -Force dist, target
```

If Windows reports that files under `target` are in use, close any running `bongo-cat.exe` process and retry.

## Checks

Run ESLint with auto-fix:

```bash
pnpm lint
```

Run a Rust check for the Tauri app:

```bash
cargo check -p bongo-cat
```

Run a Rust check for the administrator status plugin:

```bash
cargo check -p tauri-plugin-admin-status
```

## Release

Run the configured release flow:

```bash
pnpm release
```

The release script syncs package metadata through `scripts/release.ts` and uses `release-it`.
