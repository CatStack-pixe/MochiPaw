//! §B16 编译期字符串加密(obfstr)集中表。
//!
//! 仅 Windows 启用。所有字面量在 `.rdata` 中以 XOR 密文存放,调用对应函数时
//! 会在栈上解出来产成 `String`。匹配后丢弃即可被 LLVM 优化释放,
//! 调用方亦可用 `zeroize::Zeroize::zeroize` 显式清零。

#![cfg(target_os = "windows")]

use obfstr::obfstr as s;

/// 进程黑名单(§A7 / §B12 共享):全部以小写形式返回,运行期 `contains` 子串匹配。
pub fn proc_blacklist_lowercase() -> Vec<String> {
    vec![
        s!("cheatengine").into(),
        s!("cheat engine").into(),
        s!("ceserver").into(),
        s!("dbk64").into(),
        s!("dbk32").into(),
        s!("x64dbg").into(),
        s!("x32dbg").into(),
        s!("ollydbg").into(),
        s!("ollyice").into(),
        s!("ida.exe").into(),
        s!("ida64.exe").into(),
        s!("ida32.exe").into(),
        s!("idaq.exe").into(),
        s!("idaq64.exe").into(),
        s!("processhacker").into(),
        s!("system informer").into(),
        s!("systeminformer").into(),
        s!("scyllahide").into(),
        s!("scylla.exe").into(),
        s!("windbg").into(),
        s!("windbgx").into(),
        s!("dnspy").into(),
        s!("api monitor").into(),
        s!("apimonitor").into(),
        s!("hxd.exe").into(),
        s!("pchunter").into(),
        s!("peid").into(),
        s!("ce.exe").into(),
        s!("frida").into(),
        s!("frida-server").into(),
    ]
}

/// §B12 LdrRegisterDllNotification 黑名单:已知作弊器/注入器 DLL,小写。
pub fn dll_blacklist_lowercase() -> Vec<String> {
    vec![
        s!("frida-agent.dll").into(),
        s!("frida-gadget.dll").into(),
        s!("frida-helper.dll").into(),
        s!("vehdebug-x86_64.dll").into(),
        s!("vehdebug-i386.dll").into(),
        s!("speedhack-x86_64.dll").into(),
        s!("speedhack-i386.dll").into(),
        s!("scylla_hide.dll").into(),
        s!("scyllahide.dll").into(),
        s!("hookx64.dll").into(),
        s!("hookx32.dll").into(),
        s!("dbk64.sys").into(),
        s!("dbk32.sys").into(),
        s!("ce.dll").into(),
        s!("cheatengine64.dll").into(),
    ]
}

/// §B11 / §B17 关键 ntdll 导出名称(明文 ASCII,仅运行期解出后调 GetProcAddress)。
pub fn ntdll_exports_ascii() -> Vec<Vec<u8>> {
    vec![
        s!("NtReadVirtualMemory").as_bytes().to_vec(),
        s!("NtWriteVirtualMemory").as_bytes().to_vec(),
        s!("NtProtectVirtualMemory").as_bytes().to_vec(),
        s!("NtAllocateVirtualMemory").as_bytes().to_vec(),
        s!("NtFreeVirtualMemory").as_bytes().to_vec(),
        s!("NtOpenProcess").as_bytes().to_vec(),
        s!("NtQueryInformationProcess").as_bytes().to_vec(),
        s!("NtSetInformationProcess").as_bytes().to_vec(),
        s!("NtQuerySystemInformation").as_bytes().to_vec(),
        s!("NtSetInformationThread").as_bytes().to_vec(),
        s!("NtQueryInformationThread").as_bytes().to_vec(),
        s!("NtCreateThreadEx").as_bytes().to_vec(),
        s!("NtMapViewOfSection").as_bytes().to_vec(),
        s!("NtUnmapViewOfSection").as_bytes().to_vec(),
        s!("NtOpenSection").as_bytes().to_vec(),
        s!("NtClose").as_bytes().to_vec(),
        s!("DbgUiRemoteBreakin").as_bytes().to_vec(),
        s!("DbgBreakPoint").as_bytes().to_vec(),
    ]
}

/// §B17 ETW 写入侧关键导出名(配合 §B11 同框架检测)。
pub fn etw_exports_ascii() -> Vec<Vec<u8>> {
    vec![
        s!("EtwEventWrite").as_bytes().to_vec(),
        s!("EtwEventWriteFull").as_bytes().to_vec(),
        s!("EtwEventWriteEx").as_bytes().to_vec(),
        s!("NtTraceEvent").as_bytes().to_vec(),
        s!("EtwNotificationRegister").as_bytes().to_vec(),
    ]
}

/// §B18 父进程镜像名白名单(小写文件名,不含路径)。
pub fn parent_whitelist_lowercase() -> Vec<String> {
    vec![
        s!("explorer.exe").into(),
        s!("services.exe").into(),
        s!("runtimebroker.exe").into(),
        s!("svchost.exe").into(),
        s!("userinit.exe").into(),
        s!("sihost.exe").into(),
        s!("startmenuexperiencehost.exe").into(),
        // 自家 updater / installer 镜像名:
        s!("bongo-cat.exe").into(),
        s!("bongo_cat.exe").into(),
        s!("bongocat.exe").into(),
        // 调试启动:debug 配置允许 cargo / rust-test 启动
        s!("cargo.exe").into(),
        s!("rust-test").into(),
    ]
}

/// §A7 / §B12 系统镜像路径关键词(用于降假阳性,小写)。
pub fn system_path_keywords_lowercase() -> Vec<String> {
    vec![
        s!("\\program files\\").into(),
        s!("\\program files (x86)\\").into(),
        s!("\\windows\\system32\\").into(),
        s!("\\windows\\syswow64\\").into(),
        s!("\\windows\\winsxs\\").into(),
    ]
}

/// `KnownDlls` 段路径,§B11 通过 NtOpenSection 打开。
/// 注意返回 UTF-16 序列(以 0 结尾)以适配 NT 内部 OBJECT_ATTRIBUTES。
pub fn known_dll_ntdll_utf16() -> Vec<u16> {
    let mut v: Vec<u16> = s!("\\KnownDlls\\ntdll.dll").encode_utf16().collect();
    v.push(0);
    v
}

/// §C20 KnownDlls\\kernelbase.dll(NT 路径,UTF-16 含 0)。
pub fn known_dll_kernelbase_utf16() -> Vec<u16> {
    let mut v: Vec<u16> = s!("\\KnownDlls\\kernelbase.dll").encode_utf16().collect();
    v.push(0);
    v
}

/// §C20 KnownDlls\\kernel32.dll(NT 路径,UTF-16 含 0)。
pub fn known_dll_kernel32_utf16() -> Vec<u16> {
    let mut v: Vec<u16> = s!("\\KnownDlls\\kernel32.dll").encode_utf16().collect();
    v.push(0);
    v
}

/// §C20 kernelbase 关键导出列表。Cheat Engine 改值 / WPM patch 必经路径。
pub fn kernelbase_exports_ascii() -> Vec<Vec<u8>> {
    vec![
        s!("ReadProcessMemory").as_bytes().to_vec(),
        s!("WriteProcessMemory").as_bytes().to_vec(),
        s!("VirtualProtectEx").as_bytes().to_vec(),
        s!("VirtualAllocEx").as_bytes().to_vec(),
        s!("VirtualFreeEx").as_bytes().to_vec(),
        s!("OpenProcess").as_bytes().to_vec(),
        s!("CreateRemoteThreadEx").as_bytes().to_vec(),
        s!("SetWindowsHookExW").as_bytes().to_vec(),
        s!("SetWindowsHookExA").as_bytes().to_vec(),
        s!("SetThreadContext").as_bytes().to_vec(),
        s!("Wow64SetThreadContext").as_bytes().to_vec(),
        s!("DebugActiveProcess").as_bytes().to_vec(),
        s!("DebugActiveProcessStop").as_bytes().to_vec(),
    ]
}

/// §C20 kernel32 关键导出兜底(多数转发到 kernelbase,这里只保留 hook 高频目标)。
pub fn kernel32_exports_ascii() -> Vec<Vec<u8>> {
    vec![
        s!("OpenProcess").as_bytes().to_vec(),
        s!("CreateRemoteThread").as_bytes().to_vec(),
        s!("WriteProcessMemory").as_bytes().to_vec(),
        s!("ReadProcessMemory").as_bytes().to_vec(),
        s!("VirtualAllocEx").as_bytes().to_vec(),
        s!("VirtualProtectEx").as_bytes().to_vec(),
    ]
}
