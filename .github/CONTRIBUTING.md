# Contributing

Thanks for taking the time to work on MochiPaw.

## Issues

Use GitHub Issues for bug reports and feature requests:

https://github.com/CatStack-pixe/MochiPaw/issues

Before opening a new issue, search existing issues first. For bugs, include
clear reproduction steps, the app version, the operating system, and screenshots
or logs when they help explain the problem.

## Pull Requests

1. Open or claim an issue before doing larger work.
2. Keep changes focused. Avoid mixing unrelated refactors with a feature or fix.
3. Run the relevant checks before opening a PR.
4. Describe what changed and how it was tested.

## Local Setup

Install the required toolchains:

- Node.js 22 or newer
- pnpm
- Rust stable
- Tauri prerequisites for your operating system

Install dependencies:

```bash
pnpm install
```

Run the desktop app in development:

```bash
pnpm tauri dev
```

Build the app:

```bash
pnpm tauri build
```

## Commits

Use conventional commit types where possible:

- feat: feature work
- fix: bug fix
- docs: documentation
- style: formatting or style-only changes
- refactor: code restructuring without behavior changes
- perf: performance work
- chore: maintenance

## License

MochiPaw is source-available for noncommercial use. By contributing, you agree
that your contribution may be distributed under the repository's current
license terms.

Commercial use requires written permission from CatStack / InfinityXCat.
