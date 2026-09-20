// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

//! Installer-only permission provisioning for executable-local Windows data.
//!
//! This module never starts the application, initializes its data layout, changes
//! the executable directory's ACL, or imports profile data. Callers must obtain
//! the executable path themselves; it must not come from installer command-line
//! input. A repair grants one identified user Modify, retaining all existing ACEs.

use std::{
    ffi::OsStr,
    fs,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};

use windows::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, HLOCAL,
            LUID, LocalFree,
        },
        Security::{
            ACE_FLAGS, ACL, AdjustTokenPrivileges,
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSidToSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS,
                SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
            },
            DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, GetTokenInformation, InitializeSecurityDescriptor,
            IsValidSid, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, PSECURITY_DESCRIPTOR, PSID,
            SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_DEFAULTED, SE_DACL_PROTECTED,
            SE_DEBUG_NAME, SE_PRIVILEGE_ENABLED, SECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT, SetKernelObjectSecurity,
            SetSecurityDescriptorControl, SetSecurityDescriptorDacl, TOKEN_ADJUST_PRIVILEGES,
            TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenSessionId, TokenUser,
        },
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
            FILE_READ_DATA, FILE_SHARE_READ, GetFileInformationByHandle, OPEN_EXISTING,
            READ_CONTROL, WRITE_DAC,
        },
        System::Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
    },
    core::{BOOL, HRESULT, PCWSTR, PWSTR},
};

const MODIFY_ACCESS: u32 =
    FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0 | DELETE.0;
// Retaining handles prevents previously validated objects being exchanged while
// another object is inspected. Bound resources instead of partially traversing.
const MAX_EXISTING_OBJECTS: usize = 65_536;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct LocalAllocation(*mut std::ffi::c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0)));
        }
    }
}

struct Sid(LocalAllocation);

impl Sid {
    fn parse(value: &str) -> Result<Self, String> {
        // ConvertStringSidToSid also accepts aliases such as "WD". Only accept
        // the unambiguous canonical form emitted by our token SID resolvers.
        if !value.starts_with("S-1-") || value.contains('\0') {
            return Err("The installation user SID is not a canonical SID".into());
        }
        let wide = wide(OsStr::new(value))?;
        let mut sid = PSID::default();
        unsafe { ConvertStringSidToSidW(PCWSTR(wide.as_ptr()), &mut sid) }
            .map_err(|error| format!("Parsing the installation user SID failed: {error}"))?;
        let owned = Self(LocalAllocation(sid.0));
        if !unsafe { IsValidSid(owned.as_ptr()) }.as_bool() || sid_string(owned.as_ptr())? != value
        {
            return Err("The installation user SID is not a canonical SID".into());
        }
        Ok(owned)
    }

    fn as_ptr(&self) -> PSID {
        PSID(self.0.0)
    }
}

fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut result = value.encode_wide().collect::<Vec<_>>();
    if result.contains(&0) {
        return Err("A Windows path or identifier contains a NUL character".into());
    }
    result.push(0);
    Ok(result)
}

fn token(process: HANDLE) -> Result<OwnedHandle, String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
        .map_err(|error| format!("Opening the installation user's token failed: {error}"))?;
    Ok(OwnedHandle(token))
}

fn sid_string(sid: PSID) -> Result<String, String> {
    let mut value = PWSTR::null();
    unsafe { ConvertSidToStringSidW(sid, &mut value) }
        .map_err(|error| format!("Reading the installation user's SID failed: {error}"))?;
    let _value = LocalAllocation(value.0.cast());
    unsafe { value.to_string() }.map_err(|error| error.to_string())
}

fn token_user_sid(token: HANDLE) -> Result<String, String> {
    let mut length = 0;
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut length) };
    if length < std::mem::size_of::<TOKEN_USER>() as u32 || length > 65_536 {
        return Err("Windows returned an invalid user-token size".into());
    }
    // TOKEN_USER contains pointers: byte buffers would not promise alignment.
    let mut buffer = vec![0_usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )
    }
    .map_err(|error| format!("Reading the installation user's token failed: {error}"))?;
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_string(user.User.Sid)
}

fn token_session(token: HANDLE) -> Result<u32, String> {
    let mut session = 0_u32;
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token,
            TokenSessionId,
            Some((&mut session as *mut u32).cast()),
            std::mem::size_of::<u32>() as u32,
            &mut length,
        )
    }
    .map_err(|error| format!("Reading the installation user's session failed: {error}"))?;
    if length != std::mem::size_of::<u32>() as u32 {
        return Err("Windows returned an invalid session-token size".into());
    }
    Ok(session)
}

/// Resolve a non-elevated installer caller before any credential transition.
pub fn current_user_sid() -> Result<String, String> {
    token_user_sid(token(unsafe { GetCurrentProcess() })?.0)
}

/// Resolve the same-session desktop user, including over-the-shoulder UAC.
/// Services/session zero and absent desktop shells are deliberately rejected.
pub fn desktop_user_sid() -> Result<String, String> {
    let current = token(unsafe { GetCurrentProcess() })?;
    let current_session = token_session(current.0)?;
    if current_session == 0 {
        return Err("No interactive installation user is available in session zero".into());
    }
    let shell = unsafe { GetShellWindow() };
    if shell.is_invalid() {
        return Err("The installation user's desktop shell is unavailable".into());
    }
    let mut process_id = 0;
    if unsafe { GetWindowThreadProcessId(shell, Some(&mut process_id)) } == 0 || process_id == 0 {
        return Err("The installation user's desktop process is unavailable".into());
    }
    let shell_token = match desktop_process_token(process_id) {
        Ok(token) => token,
        Err(error) if error.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0) => {
            // With different UAC credentials the shell belongs to another
            // account. Enable only the existing administrator privilege, only
            // while querying that shell; never substitute the admin's own SID.
            let _debug = DebugPrivilege::enable()?;
            desktop_process_token(process_id)
                .map_err(|error| format!("Opening the desktop user's token failed: {error}"))?
        }
        Err(error) => return Err(format!("Opening the desktop user's token failed: {error}")),
    };
    let mut confirmed_process_id = 0;
    if unsafe { GetShellWindow() } != shell
        || unsafe { GetWindowThreadProcessId(shell, Some(&mut confirmed_process_id)) } == 0
        || confirmed_process_id != process_id
    {
        return Err("The installation user's desktop shell changed during detection".into());
    }
    ensure_same_interactive_session(current_session, token_session(shell_token.0)?)?;
    token_user_sid(shell_token.0)
}

fn desktop_process_token(process_id: u32) -> windows::core::Result<OwnedHandle> {
    let process =
        OwnedHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)? });
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token)? };
    Ok(OwnedHandle(token))
}

struct DebugPrivilege {
    token: OwnedHandle,
    previous: TOKEN_PRIVILEGES,
}

impl DebugPrivilege {
    fn enable() -> Result<Self, String> {
        let mut handle = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                &mut handle,
            )
        }
        .map_err(|error| format!("Opening the administrator privilege token failed: {error}"))?;
        let token = OwnedHandle(handle);
        let mut luid = LUID::default();
        unsafe { LookupPrivilegeValueW(None, SE_DEBUG_NAME, &mut luid) }
            .map_err(|error| format!("Looking up the desktop-token privilege failed: {error}"))?;
        let requested = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let mut previous = TOKEN_PRIVILEGES::default();
        let mut length = 0;
        unsafe {
            AdjustTokenPrivileges(
                token.0,
                false,
                Some(&requested),
                std::mem::size_of::<TOKEN_PRIVILEGES>() as u32,
                Some(&mut previous),
                Some(&mut length),
            )
        }
        .map_err(|error| format!("Enabling the desktop-token query privilege failed: {error}"))?;
        if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
            return Err("The installer lacks the privilege to identify the desktop user; run the interactive installer with administrator approval".into());
        }
        Ok(Self { token, previous })
    }
}

impl Drop for DebugPrivilege {
    fn drop(&mut self) {
        unsafe {
            let _ = AdjustTokenPrivileges(self.token.0, false, Some(&self.previous), 0, None, None);
        }
    }
}

fn ensure_same_interactive_session(current: u32, shell: u32) -> Result<(), String> {
    if current == 0 || shell != current {
        return Err(
            "The desktop user does not belong to this interactive installation session".into(),
        );
    }
    Ok(())
}

struct LockedObject {
    handle: OwnedHandle,
    path: PathBuf,
    directory: bool,
}

impl LockedObject {
    fn open(path: &Path, modify_acl: bool) -> Result<Self, String> {
        let name = wide(path.as_os_str())?;
        let handle = OwnedHandle(
            unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    if modify_acl {
                        (READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | FILE_READ_DATA).0
                    } else {
                        (FILE_READ_ATTRIBUTES | FILE_READ_DATA).0
                    },
                    // Deny write/delete sharing to prevent setting a reparse point
                    // or replacing an inspected object. Existing
                    // incompatible handles fail the repair instead of weakening it.
                    // FILE_READ_DATA (FILE_LIST_DIRECTORY for directories) makes
                    // this a sharing-aware open; attribute-only access does not.
                    FILE_SHARE_READ,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
            }
            .map_err(|error| {
                format!(
                    "Locking {} for data permission repair failed: {error}",
                    path.display()
                )
            })?,
        );
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(handle.0, &mut info) }
            .map_err(|error| format!("Inspecting {} failed: {error}", path.display()))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(format!(
                "Data permission repair rejects reparse points: {}",
                path.display()
            ));
        }
        let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
        if !directory && info.nNumberOfLinks != 1 {
            return Err(format!(
                "Data permission repair rejects hard-linked files: {}",
                path.display()
            ));
        }
        Ok(Self {
            handle,
            path: path.to_path_buf(),
            directory,
        })
    }
}

fn executable_directory(executable: &Path) -> Result<PathBuf, String> {
    let mut components = executable.components();
    match components.next() {
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
        _ => {
            return Err(
                "Installer data repair requires an absolute local-drive executable path".into(),
            );
        }
    }
    if components.next() != Some(Component::RootDir)
        || components.any(|part| !matches!(part, Component::Normal(_)))
        || executable.file_name().is_none()
    {
        return Err(
            "Installer data repair requires an absolute executable path without traversal".into(),
        );
    }
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "The installer executable has no parent directory".into())
}

/// Provision only `executable.parent()/data` for the specified user.
pub fn provision(executable: &Path, user_sid: &str) -> Result<(), String> {
    let sid = Sid::parse(user_sid)?;
    let parent = executable_directory(executable)?;
    let mut ancestors = parent.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    let mut locks = Vec::new();
    for path in ancestors {
        let object = LockedObject::open(path, false)?;
        if !object.directory {
            return Err(format!(
                "An installation ancestor is not a directory: {}",
                path.display()
            ));
        }
        locks.push(object);
    }

    let data = parent.join("data");
    match fs::create_dir(&data) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("Creating {} failed: {error}", data.display())),
    }
    let root = LockedObject::open(&data, true)?;
    if !root.directory {
        return Err(format!(
            "The data path is not a directory: {}",
            data.display()
        ));
    }
    let mut objects = vec![root];
    let mut index = 0;
    // Validate and retain all existing objects before modifying any ACL. Parent
    // handles stay alive throughout path-based enumeration and child opens.
    while index < objects.len() {
        if objects[index].directory {
            for entry in fs::read_dir(&objects[index].path).map_err(|error| {
                format!("Listing {} failed: {error}", objects[index].path.display())
            })? {
                let entry =
                    entry.map_err(|error| format!("Listing existing data failed: {error}"))?;
                if objects.len() >= MAX_EXISTING_OBJECTS {
                    return Err("The existing data tree exceeds the installer repair limit".into());
                }
                objects.push(LockedObject::open(&entry.path(), true)?);
            }
        }
        index += 1;
    }
    for object in &objects {
        grant_modify(object, &sid)?;
    }
    // `locks` and `objects` intentionally remain alive until every ACL update.
    Ok(())
}

fn grant_modify(object: &LockedObject, sid: &Sid) -> Result<(), String> {
    // Windows permits additional hard-link names even with delete sharing
    // denied. Recheck immediately before the write. Such an addition cannot
    // exchange this retained handle for a preexisting protected outside file.
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(object.handle.0, &mut info) }
        .map_err(|error| format!("Rechecking {} failed: {error}", object.path.display()))?;
    if !object.directory && info.nNumberOfLinks != 1 {
        return Err(format!(
            "Data permission repair rejects hard-linked files: {}",
            object.path.display()
        ));
    }
    let descriptor = SecurityDescriptor::read(object.handle.0)?;
    let dacl = descriptor.dacl()?;
    // A null/absent DACL already grants everyone access. Replacing it with one
    // allow entry would unexpectedly revoke existing access.
    if dacl.is_null() {
        return Ok(());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: MODIFY_ACCESS,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: if object.directory {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            ACE_FLAGS(0)
        },
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: PWSTR(sid.as_ptr().0.cast()),
            ..Default::default()
        },
    };
    let mut merged: *mut ACL = ptr::null_mut();
    unsafe { SetEntriesInAclW(Some(&[entry]), Some(dacl), &mut merged) }
        .ok()
        .map_err(|error| {
            format!(
                "Merging the ACL for {} failed: {error}",
                object.path.display()
            )
        })?;
    let _merged = LocalAllocation(merged.cast());
    set_dacl_on_handle(object.handle.0, descriptor.as_ptr(), merged).map_err(|error| {
        format!(
            "Updating the ACL for {} failed: {error}",
            object.path.display()
        )
    })
}

struct SecurityDescriptor(Vec<usize>);

impl SecurityDescriptor {
    fn read(handle: HANDLE) -> Result<Self, String> {
        let mut length = 0;
        let _ = unsafe {
            GetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION.0, None, 0, &mut length)
        };
        if length == 0 || length > 1_048_576 {
            return Err("Windows returned an invalid data security descriptor size".into());
        }
        let mut value = Self(vec![
            0;
            (length as usize).div_ceil(std::mem::size_of::<usize>())
        ]);
        let pointer = PSECURITY_DESCRIPTOR(value.0.as_mut_ptr().cast());
        unsafe {
            GetKernelObjectSecurity(
                handle,
                DACL_SECURITY_INFORMATION.0,
                Some(pointer),
                length,
                &mut length,
            )
        }
        .map_err(|error| format!("Reading data security failed: {error}"))?;
        Ok(value)
    }

    fn as_ptr(&self) -> PSECURITY_DESCRIPTOR {
        PSECURITY_DESCRIPTOR(self.0.as_ptr().cast_mut().cast())
    }

    fn dacl(&self) -> Result<*mut ACL, String> {
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let mut dacl = ptr::null_mut();
        unsafe {
            GetSecurityDescriptorDacl(self.as_ptr(), &mut present, &mut dacl, &mut defaulted)
        }
        .map_err(|error| format!("Reading the existing data DACL failed: {error}"))?;
        Ok(if present.as_bool() {
            dacl
        } else {
            ptr::null_mut()
        })
    }
}

fn set_dacl_on_handle(
    handle: HANDLE,
    original: PSECURITY_DESCRIPTOR,
    dacl: *const ACL,
) -> windows::core::Result<()> {
    let mut old_control = 0;
    let mut revision = 0;
    unsafe { GetSecurityDescriptorControl(original, &mut old_control, &mut revision)? };
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let pointer = PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast());
    unsafe {
        InitializeSecurityDescriptor(pointer, 1)?;
        SetSecurityDescriptorDacl(
            pointer,
            true,
            Some(dacl),
            old_control & SE_DACL_DEFAULTED.0 != 0,
        )?;
        let preserved = SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_PROTECTED;
        SetSecurityDescriptorControl(
            pointer,
            preserved,
            SECURITY_DESCRIPTOR_CONTROL(old_control) & preserved,
        )?;
        // Deliberately use the low-level handle operation rather than the usual
        // SetSecurityInfo filesystem API, which manages inheritance throughout
        // the hierarchy. Here each existing object is handled explicitly, with
        // raw descriptor reads and writes, while future children inherit OI/CI.
        // File backup/restore is another documented use of this lower-level API:
        // https://learn.microsoft.com/windows/win32/fileio/file-security-and-access-rights
        SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, pointer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows::Win32::{
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, ImpersonateLoggedOnUser,
            PROTECTED_DACL_SECURITY_INFORMATION, RevertToSelf, SID_AND_ATTRIBUTES, TOKEN_DUPLICATE,
        },
        Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_WRITE, READ_CONTROL},
        System::IO::DeviceIoControl,
    };

    const TEST_SID: &str = "S-1-5-21-314159265-271828182-161803398-4242";
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mochipaw-installer-{}-{}-中文 #100%",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("MochiPaw.exe"), "executable sentinel").unwrap();
            Self(path)
        }

        fn executable(&self) -> PathBuf {
            self.0.join("MochiPaw.exe")
        }
        fn data(&self) -> PathBuf {
            self.0.join("data")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn security_snapshot(path: &Path) -> (Vec<u8>, u16) {
        let name = wide(path.as_os_str()).unwrap();
        let handle = OwnedHandle(
            unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    READ_CONTROL.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
            }
            .unwrap(),
        );
        let descriptor = SecurityDescriptor::read(handle.0).unwrap();
        let dacl = descriptor.dacl().unwrap();
        assert!(!dacl.is_null());
        let mut control = 0;
        let mut revision = 0;
        unsafe { GetSecurityDescriptorControl(descriptor.as_ptr(), &mut control, &mut revision) }
            .unwrap();
        (
            unsafe { std::slice::from_raw_parts(dacl.cast(), (*dacl).AclSize as usize).to_vec() },
            control,
        )
    }

    fn acl(path: &Path) -> Vec<u8> {
        security_snapshot(path).0
    }

    struct Impersonation;

    impl Drop for Impersonation {
        fn drop(&mut self) {
            unsafe { RevertToSelf() }.unwrap();
        }
    }

    fn as_restricted_user<T>(operation: impl FnOnce() -> T) -> T {
        let mut base = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                &mut base,
            )
        }
        .unwrap();
        let base = OwnedHandle(base);
        let sid = Sid::parse(TEST_SID).unwrap();
        let restrict = [SID_AND_ATTRIBUTES {
            Sid: sid.as_ptr(),
            Attributes: 0,
        }];
        let mut restricted = HANDLE::default();
        unsafe {
            CreateRestrictedToken(
                base.0,
                DISABLE_MAX_PRIVILEGE,
                None,
                None,
                Some(&restrict),
                &mut restricted,
            )
        }
        .unwrap();
        let restricted = OwnedHandle(restricted);
        unsafe { ImpersonateLoggedOnUser(restricted.0) }.unwrap();
        let _impersonation = Impersonation;
        operation()
    }

    fn junction(link: &Path, destination: &Path) -> Result<(), String> {
        #[repr(C)]
        struct JunctionData {
            tag: u32,
            length: u16,
            reserved: u16,
            substitute_offset: u16,
            substitute_length: u16,
            print_offset: u16,
            print_length: u16,
            paths: [u16; 2048],
        }
        // Native NTFS mount-point reparse data requires no symlink privilege,
        // so this security regression also runs under an ordinary local user.
        let substitute = wide(OsStr::new(&format!(r"\??\{}", destination.display())))?;
        let print = wide(destination.as_os_str())?;
        assert!(substitute.len() + print.len() < 2048);
        let mut data = JunctionData {
            tag: 0xa000_0003,
            length: (8 + 2 * (substitute.len() + print.len())) as u16,
            reserved: 0,
            substitute_offset: 0,
            substitute_length: (2 * (substitute.len() - 1)) as u16,
            print_offset: (2 * substitute.len()) as u16,
            print_length: (2 * (print.len() - 1)) as u16,
            paths: [0; 2048],
        };
        data.paths[..substitute.len()].copy_from_slice(&substitute);
        data.paths[substitute.len()..substitute.len() + print.len()].copy_from_slice(&print);
        match fs::create_dir(link) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        let name = wide(link.as_os_str())?;
        let handle = OwnedHandle(
            unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    0x4000_0000,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
            }
            .map_err(|error| error.to_string())?,
        );
        let mut returned = 0;
        unsafe {
            DeviceIoControl(
                handle.0,
                0x0009_00a4,
                Some((&data as *const JunctionData).cast()),
                u32::from(data.length) + 8,
                None,
                0,
                Some(&mut returned),
                None,
            )
        }
        .map_err(|error| error.to_string())
    }

    fn make_private_directory(path: &Path) {
        // Inheritance-aware queries can normalize their returned ACE flags for
        // protected private trees. Raw snapshots verify the stored descriptor.
        let text = wide(OsStr::new(
            "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)",
        ))
        .unwrap();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                1,
                &mut descriptor,
                None,
            )
        }
        .unwrap();
        let _descriptor = LocalAllocation(descriptor.0);
        let directory = LockedObject::open(path, true).unwrap();
        unsafe {
            SetKernelObjectSecurity(
                directory.handle.0,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        }
        .unwrap();
    }

    #[test]
    fn repair_preserves_existing_data_and_parent_acl_and_is_repeatable() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.data().join("pinia")).unwrap();
        let settings = fixture.data().join("pinia/settings.json");
        fs::write(&settings, "existing user settings").unwrap();
        let parent_before = acl(&fixture.0);
        let executable_before = acl(&fixture.executable());
        for _ in 0..2 {
            provision(&fixture.executable(), &current_user_sid().unwrap()).unwrap();
            assert_eq!(
                fs::read_to_string(&settings).unwrap(),
                "existing user settings"
            );
            assert_eq!(acl(&fixture.0), parent_before);
            assert_eq!(acl(&fixture.executable()), executable_before);
            assert!(!fixture.data().join("layout.json").exists());
        }
    }

    #[test]
    fn restricted_user_can_write_existing_and_new_data_but_not_installation() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.data().join("pinia")).unwrap();
        let settings = fixture.data().join("pinia/settings.json");
        fs::write(&settings, "before").unwrap();
        assert!(as_restricted_user(|| fs::write(&settings, "blocked")).is_err());
        provision(&fixture.executable(), TEST_SID).unwrap();
        as_restricted_user(|| {
            fs::write(&settings, "after").unwrap();
            fs::create_dir(fixture.data().join("new models")).unwrap();
            fs::write(fixture.data().join("new models/model.json"), "new").unwrap();
            fs::remove_file(fixture.data().join("new models/model.json")).unwrap();
            assert!(fs::write(fixture.executable(), "replace executable").is_err());
            assert!(fs::write(fixture.0.join("another.exe"), "new executable").is_err());
        });
        assert_eq!(fs::read_to_string(&settings).unwrap(), "after");
    }

    #[test]
    fn one_handle_acl_update_does_not_propagate_to_existing_children() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.data()).unwrap();
        make_private_directory(&fixture.data());
        fs::create_dir(fixture.data().join("child")).unwrap();
        let child = fixture.data().join("child");
        let before = security_snapshot(&child);
        let root_control = security_snapshot(&fixture.data()).1;
        let root = LockedObject::open(&fixture.data(), true).unwrap();
        grant_modify(&root, &Sid::parse(TEST_SID).unwrap()).unwrap();
        assert_eq!(security_snapshot(&child), before);
        assert_eq!(security_snapshot(&fixture.data()).1, root_control);
    }

    #[test]
    fn handle_acl_write_never_follows_a_new_child_junction() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.data()).unwrap();
        make_private_directory(&fixture.data());
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let outside_file = outside.join("existing.json");
        fs::write(&outside_file, "outside data").unwrap();
        let directory_before = acl(&outside);
        let file_before = acl(&outside_file);
        let root = LockedObject::open(&fixture.data(), true).unwrap();
        // Directory sharing locks do not prevent insertion of new children.
        // Simulate insertion after traversal: the write must stay handle-only.
        let link = fixture.data().join("racing junction");
        junction(&link, &outside).unwrap();
        grant_modify(&root, &Sid::parse(TEST_SID).unwrap()).unwrap();
        assert_eq!(acl(&outside), directory_before);
        assert_eq!(acl(&outside_file), file_before);
        drop(root);
        fs::remove_dir(link).unwrap();
    }

    #[test]
    fn invalid_sids_and_paths_do_not_create_data() {
        let fixture = Fixture::new();
        for sid in ["", "WD", "not-a-sid", "S-1-5-", "S-1-5-18\0extra"] {
            assert!(provision(&fixture.executable(), sid).is_err());
            assert!(!fixture.data().exists());
        }
        for path in [
            r"relative.exe",
            r"C:\one\..\two\app.exe",
            r"\\server\share\app.exe",
        ] {
            assert!(executable_directory(Path::new(path)).is_err());
        }
    }

    #[test]
    fn file_at_data_path_and_hard_links_are_rejected_without_acl_changes() {
        let fixture = Fixture::new();
        fs::write(fixture.data(), "blocked").unwrap();
        let before = acl(&fixture.data());
        assert!(
            provision(&fixture.executable(), TEST_SID)
                .unwrap_err()
                .contains("not a directory")
        );
        assert_eq!(acl(&fixture.data()), before);
        fs::remove_file(fixture.data()).unwrap();
        fs::create_dir(fixture.data()).unwrap();
        let outside = fixture.0.join("outside.txt");
        fs::write(&outside, "outside data").unwrap();
        fs::hard_link(&outside, fixture.data().join("linked.txt")).unwrap();
        let outside_before = acl(&outside);
        let data_before = acl(&fixture.data());
        assert!(
            provision(&fixture.executable(), TEST_SID)
                .unwrap_err()
                .contains("hard-linked")
        );
        assert_eq!(acl(&outside), outside_before);
        assert_eq!(acl(&fixture.data()), data_before);
    }

    #[test]
    fn retained_handles_block_replacement_and_writers() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let _ancestor = LockedObject::open(&fixture.0, false).unwrap();
        assert!(fs::rename(&fixture.0, fixture.0.with_extension("moved")).is_err());
        fs::create_dir(fixture.data()).unwrap();
        let file = fixture.data().join("settings.json");
        fs::write(&file, "original").unwrap();
        let _root = LockedObject::open(&fixture.data(), true).unwrap();
        let locked_file = LockedObject::open(&file, true).unwrap();
        assert!(fs::rename(fixture.data(), fixture.0.join("moved")).is_err());
        assert!(fs::remove_file(&file).is_err());
        assert!(fs::write(&file, "racing writer").is_err());
        assert!(junction(&fixture.data(), &fixture.0).is_err());
        // An extra name for this same retained object is possible. It cannot
        // substitute a protected outside object, and our last check rejects it.
        fs::hard_link(&file, outside.0.join("outside-link")).unwrap();
        assert!(
            grant_modify(&locked_file, &Sid::parse(TEST_SID).unwrap())
                .unwrap_err()
                .contains("hard-linked")
        );
    }

    #[test]
    fn root_and_descendant_junctions_are_rejected_without_touching_their_targets() {
        for at_root in [true, false] {
            let fixture = Fixture::new();
            let outside = fixture.0.join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("sentinel.json"), "outside data").unwrap();
            let before = acl(&outside);
            let link = if at_root {
                fixture.data()
            } else {
                fs::create_dir(fixture.data()).unwrap();
                fixture.data().join("linked model")
            };
            junction(&link, &outside).unwrap();
            let error = provision(&fixture.executable(), TEST_SID).unwrap_err();
            assert!(error.contains("reparse points"), "{error}");
            assert_eq!(acl(&outside), before);
            assert_eq!(
                fs::read_to_string(outside.join("sentinel.json")).unwrap(),
                "outside data"
            );
            fs::remove_dir(&link).unwrap();
        }
    }

    #[test]
    fn session_mismatch_and_noninteractive_sessions_are_rejected() {
        assert!(ensure_same_interactive_session(1, 1).is_ok());
        assert!(ensure_same_interactive_session(0, 0).is_err());
        assert!(ensure_same_interactive_session(1, 2).is_err());
        Sid::parse(&current_user_sid().unwrap()).unwrap();
    }
}
