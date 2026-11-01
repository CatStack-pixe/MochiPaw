# Build status

- Standalone .NET 8 full-trust bridge publishes successfully.
- Rust Windows window-plugin `cargo check --offline` passes.
- Frontend typecheck, targeted ESLint, Vite build, and 304 repository tests
  pass.
- XML parsing for the manifest, project, XAML, and trimming directives passes.
- `pnpm package:gamebar-widget` now includes an MSBuild packaging step and
  fails explicitly when Visual Studio/MSBuild with the UWP workload is absent.
- This machine lacks `Microsoft.Windows.UI.Xaml.CSharp.targets`, so the UWP
  widget/MSIX cannot be compiled or runtime-tested here. No successful MSIX
  build/install is claimed.
- Runtime acceptance still requires Windows UWP workload and a matching
  signing certificate; test widget activation (`Win+G`), pinning, fullscreen,
  click-through, and actual render rate.
- Only the three packaged model modes are currently shipped to the widget;
  arbitrary imported model directories are not included.
