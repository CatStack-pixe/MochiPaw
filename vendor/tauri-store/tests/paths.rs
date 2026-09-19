use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Manager};
use tauri_store::{DefaultMarker, ManagerExt, StoreCollection};

#[cfg(debug_assertions)]
const META: &str = "meta.dev.tauristore";
#[cfg(not(debug_assertions))]
const META: &str = "meta.tauristore";
const NAME: &str = "path-regression";

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
  root: PathBuf,
  config: PathBuf,
}

impl Fixture {
  fn new() -> Self {
    let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let root = std::env::temp_dir().join(format!(
      "tauri-store-path-tests-{}-{nanos}-{sequence}",
      std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let config = root.join("mock-platform-config");
    Self { root, config }
  }

  fn app(&self) -> App<MockRuntime> {
    // An absolute mock identifier confines Tauri's config/data resolvers to this fixture.
    // No test reads or writes the user's actual application data.
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = self.config.to_str().unwrap().to_owned();
    let app = mock_builder().build(context).unwrap();
    assert_eq!(app.path().app_config_dir().unwrap(), self.config);
    assert_eq!(app.path().app_data_dir().unwrap(), self.config);
    app
  }

  fn legacy_meta(&self) -> PathBuf {
    self.config.join(NAME).join(META)
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    fs::remove_dir_all(&self.root).unwrap();
  }
}

fn write_meta(path: &Path, value: &Value) {
  fs::create_dir_all(path.parent().unwrap()).unwrap();
  fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn read_meta(path: &Path) -> Value {
  serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn explicit_path_ignores_legacy_metadata_and_round_trips_local_state() {
  let fixture = Fixture::new();
  let legacy = fixture.legacy_meta();
  fs::create_dir_all(legacy.parent().unwrap()).unwrap();
  fs::write(&legacy, b"invalid legacy metadata: must never be read").unwrap();
  let local = fixture.root.join("portable/data/pinia");
  {
    let app = fixture.app();
    StoreCollection::<_, DefaultMarker>::builder()
      .path(&local)
      .build(&app, NAME)
      .unwrap();
    let collection = app.store_collection();
    assert_eq!(collection.path(), local);
    collection.set("settings", "value", 42).unwrap();
    collection.save_all_now().unwrap();
    collection.on_exit().unwrap();
  }
  assert_eq!(read_meta(&local.join(META))["path"], json!(local));
  assert_eq!(
    fs::read(&legacy).unwrap(),
    b"invalid legacy metadata: must never be read"
  );
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .path(&local)
    .build(&app, NAME)
    .unwrap();
  assert_eq!(
    app.store_collection().get("settings", "value"),
    Some(json!(42))
  );
}

#[test]
fn relocated_portable_directory_ignores_its_persisted_absolute_path() {
  let fixture = Fixture::new();
  let old = fixture.root.join("original");
  let new = fixture.root.join("relocated");
  {
    let app = fixture.app();
    StoreCollection::<_, DefaultMarker>::builder()
      .path(&old)
      .build(&app, NAME)
      .unwrap();
    let collection = app.store_collection();
    collection.set("settings", "value", 42).unwrap();
    collection.save_all_now().unwrap();
    collection.on_exit().unwrap();
  }
  fs::rename(&old, &new).unwrap();
  assert_eq!(read_meta(&new.join(META))["path"], json!(old));
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .path(&new)
    .build(&app, NAME)
    .unwrap();
  let collection = app.store_collection();
  assert_eq!(collection.path(), new);
  assert_eq!(collection.get("settings", "value"), Some(json!(42)));
  collection.on_exit().unwrap();
  assert_eq!(read_meta(&new.join(META))["path"], json!(new));
  assert!(!old.exists());
  assert!(!fixture.config.exists());
}

#[test]
fn default_builder_retains_platform_metadata_and_saved_collection_path() {
  let fixture = Fixture::new();
  let saved = fixture.root.join("saved-default-path");
  write_meta(&fixture.legacy_meta(), &json!({ "path": saved }));
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .build(&app, NAME)
    .unwrap();
  let collection = app.store_collection();
  assert_eq!(collection.path(), saved);
  collection.set("settings", "value", 42).unwrap();
  collection.save_all_now().unwrap();
  collection.on_exit().unwrap();
  assert_eq!(read_meta(&fixture.legacy_meta())["path"], json!(saved));
  assert!(!saved.join(META).exists());
}

#[test]
fn default_builder_without_saved_path_uses_platform_data_directory() {
  let fixture = Fixture::new();
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .build(&app, NAME)
    .unwrap();
  assert_eq!(app.store_collection().path(), fixture.config.join(NAME));
}

#[test]
fn explicit_set_path_saves_metadata_even_without_active_stores() {
  let fixture = Fixture::new();
  let first = fixture.root.join("first");
  let next = fixture.root.join("next");
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .path(&first)
    .build(&app, NAME)
    .unwrap();
  let collection = app.store_collection();
  collection.set_path(&next).unwrap();
  assert_eq!(collection.path(), next);
  assert_eq!(read_meta(&next.join(META))["path"], json!(next));
  assert!(!fixture.config.exists());
}

#[test]
fn explicit_set_path_moves_active_stores_and_metadata_together() {
  let fixture = Fixture::new();
  let first = fixture.root.join("first");
  let next = fixture.root.join("next");
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .path(&first)
    .build(&app, NAME)
    .unwrap();
  let collection = app.store_collection();
  collection.set("settings", "value", 42).unwrap();
  collection.save_all_now().unwrap();
  let old_store = collection
    .with_store("settings", |store| store.path())
    .unwrap();
  collection.set_path(&next).unwrap();
  let new_store = collection
    .with_store("settings", |store| store.path())
    .unwrap();
  assert!(!old_store.exists());
  assert!(new_store.starts_with(&next));
  assert!(new_store.exists());
  assert_eq!(read_meta(&next.join(META))["path"], json!(next));
  assert!(!fixture.config.exists());
}

#[cfg(feature = "unstable-migration")]
#[test]
fn relocation_preserves_colocated_migration_history() {
  use tauri_store::Migration;
  let fixture = Fixture::new();
  let local = fixture.root.join("relocated");
  let old = fixture.root.join("original");
  write_meta(
    &local.join(META),
    &json!({ "path": old, "migration_history": { "settings": "1.0.0" } }),
  );
  let app = fixture.app();
  StoreCollection::<_, DefaultMarker>::builder()
    .path(&local)
    .migration(
      "settings",
      Migration::new("1.0.0", |_| panic!("migration already ran")),
    )
    .migration(
      "settings",
      Migration::new("2.0.0", |state| {
        state.set("migrated", json!(true));
        Ok(())
      }),
    )
    .build(&app, NAME)
    .unwrap();
  let collection = app.store_collection();
  assert_eq!(collection.get("settings", "migrated"), Some(json!(true)));
  let meta = read_meta(&local.join(META));
  assert_eq!(meta["path"], json!(local));
  assert_eq!(meta["migration_history"]["settings"], "2.0.0");
  assert!(!fixture.config.exists());
}
