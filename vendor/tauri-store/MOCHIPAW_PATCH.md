# MochiPaw local patch: explicit collection directories

This is `tauri-store` 0.12.1, vendored from its published crates.io package.
Upstream source: https://github.com/ferreira-tb/tauri-store
Upstream revision: `c0ccce3d7429a4af1c923370376d03ba6b85f175`
Upstream package directory: `crates/tauri-store`.

The published package has an MIT license declaration but omits the license
file. `LICENSE` is preserved from the repository root at that exact revision.
The published source, normalized Cargo manifest, original manifest, README,
build script, assets, permissions, and upstream tests are retained. Registry
markers and the upstream Cargo lockfile are omitted.

## Scoped behavior

- A collection with an explicit builder `.path(directory)` reads its metadata
  from `directory/meta.dev.tauristore` in debug builds, or
  `directory/meta.tauristore` in release builds. It never resolves, reads, or
  writes platform app-config metadata. All later metadata writes use the same
  rule, including migration history and application exit.
- The explicit builder path is authoritative even when local metadata contains
  an old absolute path. Moving an entire portable directory therefore does not
  redirect settings back to its original location. Metadata's path field is
  retained for format compatibility and refreshed when metadata is saved.
- A collection without an explicit builder path keeps the upstream behavior:
  metadata lives in `app_config_dir()/plugin_name`, its saved collection path
  wins, and the fallback collection path is `app_data_dir()/plugin_name`.
- Runtime `set_path` continues moving only active stores. For an explicitly
  configured collection, subsequent metadata writes follow its new current
  directory. An explicit collection's path change with no active stores now
  saves metadata immediately as well. Default collections retain their original
  persistence behavior. A later builder's explicit path remains authoritative; this patch
  does not discover, copy, delete, or follow old data directories on startup.
- Migration history continues to load from and save to the chosen metadata
  file. Colocated migration history survives moving a portable directory.

MochiPaw opts into this behavior only on Windows by setting the Pinia builder's
path to its executable-relative data directory. Other platforms omit the path
and retain their existing metadata behavior.

## Validation

`tests/paths.rs` uses Tauri's mock runtime and temporary fixture directories.
The mock app identifier is an absolute fixture path, so even default-path tests
never access the user's application data. Coverage includes malformed legacy
metadata being ignored, local settings round trips, portable relocation,
default behavior with and without a saved path, runtime path changes with and
without active stores, and migration history after relocation.

Run the scoped suite with:

```sh
cargo test --manifest-path vendor/tauri-store/Cargo.toml --test paths --features unstable-migration
```

On Windows, set `TAURI_STORE_WORKSPACE=true` before compiling this standalone
test crate. The upstream build script then embeds the common-controls manifest
needed by Tauri's mock-runtime test executable. This patch tracks that variable
and the manifest file in the build script so Cargo rebuilds after they change.

Remove this override when upstream provides equivalent explicit-path metadata
isolation and path precedence; retain these regression scenarios when upgrading.
