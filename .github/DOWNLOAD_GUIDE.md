# Download Guide

## Windows

Windows releases provide MSI and NSIS installers. Tagged releases also include
a portable ZIP that can run without installation.

1. Open the Releases page:
   https://github.com/CatStack-pixe/MochiPaw/releases
2. Download the latest `.msi` or `.exe` installer, or the portable ZIP.
3. Extract the portable ZIP and run `MochiPaw.exe` without installing it.

## macOS and Linux

Tagged releases build macOS and Linux packages alongside Windows:

- macOS: `.dmg` and `.app`
- Linux: `.AppImage`, `.deb`, and `.rpm`

If a package is not available for your architecture, build from source:

```bash
pnpm install
pnpm tauri build
```

## License

MochiPaw is available for personal, learning, research, and other
noncommercial use. Commercial use requires written permission from
CatStack / InfinityXCat.
