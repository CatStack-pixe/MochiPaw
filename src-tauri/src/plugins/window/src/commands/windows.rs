// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Runtime, WebviewWindow, command};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
};

static TOPMOST_WINDOWS: OnceLock<Mutex<HashMap<isize, Arc<AtomicBool>>>> = OnceLock::new();

#[command]
pub async fn show_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[command]
pub async fn hide_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
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
