// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use futures_channel::oneshot;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Runtime, WebviewWindow, command, webview::PlatformWebview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL, ICoreWebView2_19,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
};
use windows::core::Interface;

use super::WebviewMemoryTarget;

static TOPMOST_WINDOWS: OnceLock<Mutex<HashMap<isize, Arc<AtomicBool>>>> = OnceLock::new();

#[command]
pub async fn show_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = set_webview_memory_target(window.clone(), WebviewMemoryTarget::Normal).await;
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[command]
pub async fn hide_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = set_webview_memory_target(window.clone(), WebviewMemoryTarget::Low).await;
    let _ = window.hide();
}

#[command]
pub async fn set_always_on_top<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    always_on_top: bool,
) {
    let Ok(hwnd) = window.hwnd() else { return };
    let raw_hwnd = hwnd.0 as isize;
    let windows = TOPMOST_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()));

    if always_on_top {
        let Ok(mut windows) = windows.lock() else {
            return;
        };

        if windows.contains_key(&raw_hwnd) {
            return;
        }

        let running = Arc::new(AtomicBool::new(true));

        windows.insert(raw_hwnd, Arc::clone(&running));

        thread::spawn(move || {
            let hwnd = HWND(raw_hwnd as *mut _);

            while running.load(Ordering::SeqCst) {
                let result = unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                };

                if result.is_err() {
                    break;
                }

                thread::sleep(Duration::from_millis(16));
            }

            if let Some(windows) = TOPMOST_WINDOWS.get()
                && let Ok(mut windows) = windows.lock()
            {
                let should_remove = windows
                    .get(&raw_hwnd)
                    .is_some_and(|current| Arc::ptr_eq(current, &running));

                if should_remove {
                    windows.remove(&raw_hwnd);
                }
            }
        });
    } else {
        if let Ok(mut windows) = windows.lock() {
            if let Some(running) = windows.remove(&raw_hwnd) {
                running.store(false, Ordering::SeqCst);
            }
        }

        let hwnd = HWND(raw_hwnd as *mut _);

        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_NOTOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[command]
pub async fn set_taskbar_visibility<R: Runtime>(window: WebviewWindow<R>, visible: bool) {
    let _ = window.set_skip_taskbar(!visible);
}

#[command]
pub async fn set_webview_memory_target<R: Runtime>(
    window: WebviewWindow<R>,
    target: WebviewMemoryTarget,
) -> bool {
    let (sender, receiver) = oneshot::channel();
    let scheduled = window.with_webview(move |webview| {
        let _ = sender.send(apply_webview_memory_target(webview, target));
    });

    if scheduled.is_err() {
        return false;
    }

    receiver.await.unwrap_or(false)
}

pub fn request_webview_memory_target<R: Runtime>(
    window: &WebviewWindow<R>,
    target: WebviewMemoryTarget,
) {
    let _ = window.with_webview(move |webview| {
        apply_webview_memory_target(webview, target);
    });
}

fn apply_webview_memory_target(webview: PlatformWebview, target: WebviewMemoryTarget) -> bool {
    let level = match target {
        WebviewMemoryTarget::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(0),
        WebviewMemoryTarget::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(1),
    };

    unsafe {
        webview
            .controller()
            .CoreWebView2()
            .and_then(|webview| webview.cast::<ICoreWebView2_19>())
            .and_then(|webview| webview.SetMemoryUsageTargetLevel(level))
            .is_ok()
    }
}
