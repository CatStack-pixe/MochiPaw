// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::collections::HashMap;

#[derive(Clone, Copy)]
struct ProcessEntry {
    pid: u32,
    parent_pid: u32,
    is_webview: bool,
}

#[derive(Clone, Copy)]
pub(super) struct ProcessSample {
    pub creation_time: u64,
    pub working_set_bytes: u64,
    pub private_bytes: u64,
}

pub(super) struct GroupMetrics {
    pub working_set_bytes: u64,
    pub private_bytes: u64,
    pub process_count: u32,
}

fn collect_webview_group(
    root_pid: u32,
    root: ProcessSample,
    snapshot_time: u64,
    entries: &[ProcessEntry],
    mut sample: impl FnMut(u32) -> Result<ProcessSample, String>,
) -> Result<GroupMetrics, String> {
    let mut verified = HashMap::from([(root_pid, root)]);
    let mut parents = vec![root_pid];

    while let Some(parent_pid) = parents.pop() {
        let parent_creation = verified[&parent_pid].creation_time;
        for entry in entries {
            if !entry.is_webview
                || entry.parent_pid != parent_pid
                || verified.contains_key(&entry.pid)
            {
                continue;
            }

            let child = sample(entry.pid)?;
            // Parent PIDs can be reused after a process exits. A child older
            // than its supposed parent cannot belong to this process tree.
            if child.creation_time < parent_creation {
                continue;
            }
            // A PID reused after the snapshot must not be attributed using
            // the previous process's name or parent. Retry on the next sample.
            if child.creation_time > snapshot_time {
                return Err("WebView process changed during sampling".to_string());
            }

            verified.insert(entry.pid, child);
            parents.push(entry.pid);
        }
    }

    Ok(GroupMetrics {
        // Working sets include shared pages. This sum is deliberately named
        // as such and must not be described as unique physical RAM usage.
        working_set_bytes: verified.values().map(|value| value.working_set_bytes).sum(),
        private_bytes: verified.values().map(|value| value.private_bytes).sum(),
        process_count: verified.len() as u32,
    })
}

#[cfg(target_os = "windows")]
pub(super) fn read_memory_counters(
    process: windows::Win32::Foundation::HANDLE,
) -> Result<windows::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS_EX, String> {
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };

    let mut counters = PROCESS_MEMORY_COUNTERS_EX {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(counters)
}

#[cfg(target_os = "windows")]
pub(super) fn windows_webview_group(
    root_pid: u32,
    root: ProcessSample,
) -> Result<GroupMetrics, String> {
    use windows::{
        Win32::{
            Foundation::{ERROR_NO_MORE_FILES, FILETIME},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                    TH32CS_SNAPPROCESS,
                },
                SystemInformation::GetSystemTimeAsFileTime,
                Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
            },
        },
        core::HRESULT,
    };

    let snapshot_time = super::filetime_to_u64(unsafe { GetSystemTimeAsFileTime() });
    let snapshot = super::HandleGuard(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| error.to_string())?,
    );
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut entries = Vec::new();
    unsafe { Process32FirstW(snapshot.0, &mut entry) }.map_err(|error| error.to_string())?;
    loop {
        let name_end = entry
            .szExeFile
            .iter()
            .position(|&value| value == 0)
            .unwrap_or(entry.szExeFile.len());
        entries.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            is_webview: String::from_utf16_lossy(&entry.szExeFile[..name_end])
                .eq_ignore_ascii_case("msedgewebview2.exe"),
        });
        if let Err(error) = unsafe { Process32NextW(snapshot.0, &mut entry) } {
            if error.code() != HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                return Err(error.to_string());
            }
            break;
        }
    }

    collect_webview_group(root_pid, root, snapshot_time, &entries, |pid| {
        let process = super::HandleGuard(
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .map_err(|error| error.to_string())?,
        );
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user)
                .map_err(|error| error.to_string())?;
        }
        let counters = read_memory_counters(process.0)?;
        Ok(ProcessSample {
            creation_time: super::filetime_to_u64(creation),
            working_set_bytes: counters.WorkingSetSize as u64,
            private_bytes: counters.PrivateUsage as u64,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{ProcessEntry, ProcessSample, collect_webview_group};

    fn entry(pid: u32, parent_pid: u32, is_webview: bool) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent_pid,
            is_webview,
        }
    }

    fn sample(creation_time: u64) -> ProcessSample {
        ProcessSample {
            creation_time,
            working_set_bytes: 100,
            private_bytes: 60,
        }
    }

    #[test]
    fn counts_nested_webviews_once_and_excludes_other_apps_and_native_helpers() {
        let entries = [
            entry(3, 2, true),
            entry(4, 99, true),
            entry(5, 1, false),
            entry(6, 5, true),
            entry(2, 1, true),
            entry(2, 1, true),
        ];
        let metrics = collect_webview_group(1, sample(10), 100, &entries, |pid| {
            Ok(sample(10 + u64::from(pid)))
        })
        .unwrap();
        assert_eq!(metrics.process_count, 3);
        assert_eq!(metrics.working_set_bytes, 300);
        assert_eq!(metrics.private_bytes, 180);
    }

    #[test]
    fn excludes_stale_parent_pid_relationships() {
        let entries = [entry(2, 1, true), entry(3, 2, true)];
        let metrics = collect_webview_group(1, sample(10), 100, &entries, |_| Ok(sample(9)))
            .unwrap();
        assert_eq!(metrics.process_count, 1);
    }

    #[test]
    fn reused_pid_or_unreadable_child_invalidates_the_group_sample() {
        let entries = [entry(2, 1, true)];
        assert!(
            collect_webview_group(1, sample(10), 100, &entries, |_| Ok(sample(101)))
                .is_err()
        );
        assert!(
            collect_webview_group(1, sample(10), 100, &entries, |_| Err("exited".to_string()))
                .is_err()
        );
    }

    #[test]
    fn includes_main_process_without_any_webviews() {
        let metrics = collect_webview_group(1, sample(10), 100, &[], |_| unreachable!()).unwrap();
        assert_eq!(metrics.process_count, 1);
        assert_eq!(metrics.working_set_bytes, 100);
        assert_eq!(metrics.private_bytes, 60);
    }
}
