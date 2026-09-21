// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

#[cfg(target_os = "windows")]
use std::sync::OnceLock;

use tauri::{App, AppHandle, Context, Wry};
#[cfg(target_os = "windows")]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, utils::config::WindowConfig};

#[cfg(target_os = "windows")]
static INITIAL_WINDOWS: OnceLock<Vec<WindowConfig>> = OnceLock::new();

/// Defer Windows webviews until setup can supply the executable-local data root.
/// Other platforms keep Tauri's normal automatic window creation.
pub fn configure_context(context: &mut Context<Wry>) {
    #[cfg(target_os = "windows")]
    INITIAL_WINDOWS.get_or_init(|| {
        let mut initial = Vec::new();
        for config in &mut context.config_mut().app.windows {
            if config.create {
                initial.push(config.clone());
                config.create = false;
            }
        }
        initial
    });

    #[cfg(not(target_os = "windows"))]
    let _ = context;
}

pub fn create_initial_windows(app: &App) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let directory = crate::data_paths::windows_data_paths()?.webview();
        let configs = INITIAL_WINDOWS
            .get()
            .ok_or("Initial Windows webview configuration was not prepared")?;
        for config in configs {
            // Override after from_config: Tauri resolves config dataDirectory
            // values through the system local-data directory on Windows.
            WebviewWindowBuilder::from_config(app, config)
                .map_err(|error| error.to_string())?
                .data_directory(directory.clone())
                .build()
                .map_err(|error| format!("Creating {} failed: {error}", config.label))?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = app;

    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn sub_model_target(instance_id: &str) -> Result<(String, String), String> {
    if instance_id.is_empty()
        || instance_id.len() > 128
        || !instance_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid sub-model instance ID".into());
    }

    Ok((
        format!("sub-model-{instance_id}"),
        format!("index.html/#/sub-model?instance={instance_id}"),
    ))
}

#[cfg(any(target_os = "windows", test))]
fn validate_position(x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if x.is_some_and(|value| !value.is_finite()) || y.is_some_and(|value| !value.is_finite()) {
        return Err("Sub-model window coordinates must be finite".into());
    }

    Ok(())
}

/// Windows uses native construction so every dynamic webview shares the same
/// explicit data directory as the initial windows. The frontend supplies no URL,
/// label, or filesystem path.
#[tauri::command]
pub async fn create_sub_model_window(
    app: AppHandle,
    instance_id: String,
    x: Option<f64>,
    y: Option<f64>,
    always_on_top: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (label, route) = sub_model_target(&instance_id)?;
        validate_position(x, y)?;
        if app.get_webview_window(&label).is_some() {
            return Err(format!("Sub-model window {label} already exists"));
        }

        let mut builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
            .data_directory(crate::data_paths::windows_data_paths()?.webview())
            .title("MochiPaw")
            .inner_size(300.0, 300.0)
            .shadow(false)
            .transparent(true)
            .decorations(false)
            .always_on_top(always_on_top)
            .skip_taskbar(true)
            .maximizable(false)
            .visible(false);

        if let (Some(x), Some(y)) = (x, y) {
            builder = builder.position(x, y);
        }

        builder.build().map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, instance_id, x, y, always_on_top);
        Err("Native sub-model window creation is only used on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{configure_context, sub_model_target, validate_position};

    #[test]
    fn only_defers_automatic_webviews_on_windows() {
        let mut context = crate::application_context();
        let original = context.config().app.windows.clone();
        configure_context(&mut context);

        #[cfg(target_os = "windows")]
        {
            assert!(
                context
                    .config()
                    .app
                    .windows
                    .iter()
                    .all(|config| !config.create)
            );
            let expected: Vec<_> = original
                .into_iter()
                .filter(|config| config.create)
                .collect();
            assert_eq!(super::INITIAL_WINDOWS.get().unwrap(), &expected);
        }

        #[cfg(not(target_os = "windows"))]
        assert_eq!(context.config().app.windows, original);
    }

    #[test]
    fn accepts_nanoid_ids_and_keeps_the_route_internal() {
        assert_eq!(
            sub_model_target("Abc_09-z").unwrap(),
            (
                "sub-model-Abc_09-z".into(),
                "index.html/#/sub-model?instance=Abc_09-z".into(),
            )
        );
    }

    #[test]
    fn rejects_ids_that_change_the_label_or_route() {
        for id in [
            "",
            "../main",
            "main#fragment",
            "main?query",
            "main&instance=other",
            "main%2Fother",
            "https://example.com",
            "model with spaces",
            "model\\other",
            "模型",
        ] {
            assert!(sub_model_target(id).is_err(), "accepted {id:?}");
        }
        assert!(sub_model_target(&"a".repeat(129)).is_err());
    }

    #[test]
    fn validates_optional_coordinates_before_creating_a_window() {
        assert!(validate_position(None, None).is_ok());
        assert!(validate_position(Some(-1920.0), Some(300.0)).is_ok());
        assert!(validate_position(Some(f64::NAN), None).is_err());
        assert!(validate_position(None, Some(f64::INFINITY)).is_err());
    }
}
