//! 通过 DACL 收紧自身进程对象,封堵第三方 `OpenProcess(PROCESS_VM_*)`。
//!
//! 该模块走纯 FFI(`extern "system"`)直接调用 advapi32,
//! 避免不同 windows-rs 版本的绑定差异。
//!
//! 实现思路:
//! 1. `OpenProcessToken` + `GetTokenInformation(TokenUser)` 取自身 SID;
//! 2. `AllocateAndInitializeSid` 拿 Everyone(S-1-1-0)与 SYSTEM(S-1-5-18);
//! 3. 手工构造 EXPLICIT_ACCESS_W 三条:Deny Everyone, Allow SELF, Allow SYSTEM;
//! 4. `SetEntriesInAclW` 合成 ACL,`SetSecurityInfo` 写回当前进程对象。
//!
//! 任何一步失败都静默返回 — DACL 是"最佳努力",兜底由 handle_scan 处理。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::{null, null_mut};

use crate::policy::PolicyConfig;

type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut c_void;
type PSID = *mut c_void;
type LPWSTR = *mut u16;

const TOKEN_QUERY: DWORD = 0x0008;
const TokenUser: DWORD = 1;

const PROCESS_VM_OPERATION: DWORD = 0x0008;
const PROCESS_VM_READ: DWORD = 0x0010;
const PROCESS_VM_WRITE: DWORD = 0x0020;
const PROCESS_DUP_HANDLE: DWORD = 0x0040;
const PROCESS_CREATE_THREAD: DWORD = 0x0002;
const PROCESS_SET_INFORMATION: DWORD = 0x0200;
const PROCESS_SUSPEND_RESUME: DWORD = 0x0800;
const PROCESS_ALL_ACCESS: DWORD = 0x001F_FFFF;

const SECURITY_LOCAL_SYSTEM_RID: DWORD = 18;
const SECURITY_NT_AUTHORITY: [u8; 6] = [0, 0, 0, 0, 0, 5];
const SECURITY_WORLD_SID_AUTHORITY: [u8; 6] = [0, 0, 0, 0, 0, 1];

const DACL_SECURITY_INFORMATION: DWORD = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION: DWORD = 0x8000_0000;

// SE_OBJECT_TYPE
const SE_KERNEL_OBJECT: i32 = 6;

// ACCESS_MODE
const SET_ACCESS: u32 = 2;
const DENY_ACCESS: u32 = 3;

// MULTIPLE_TRUSTEE_OPERATION
const NO_MULTIPLE_TRUSTEE: u32 = 0;

// TRUSTEE_FORM
const TRUSTEE_IS_SID: u32 = 0;

// TRUSTEE_TYPE
const TRUSTEE_IS_USER: u32 = 1;
const TRUSTEE_IS_WELL_KNOWN_GROUP: u32 = 5;

const NO_INHERITANCE: u32 = 0;

const DENY_MASK: DWORD = PROCESS_VM_OPERATION
    | PROCESS_VM_READ
    | PROCESS_VM_WRITE
    | PROCESS_DUP_HANDLE
    | PROCESS_CREATE_THREAD
    | PROCESS_SET_INFORMATION
    | PROCESS_SUSPEND_RESUME;

#[repr(C)]
struct SID_IDENTIFIER_AUTHORITY {
    Value: [u8; 6],
}

#[repr(C)]
struct TRUSTEE_W {
    pMultipleTrustee: *mut TRUSTEE_W,
    MultipleTrusteeOperation: u32,
    TrusteeForm: u32,
    TrusteeType: u32,
    ptstrName: LPWSTR,
}

#[repr(C)]
struct EXPLICIT_ACCESS_W {
    grfAccessPermissions: DWORD,
    grfAccessMode: u32,
    grfInheritance: u32,
    Trustee: TRUSTEE_W,
}

#[repr(C)]
struct TOKEN_USER {
    Sid: PSID,
    Attributes: DWORD,
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(ProcessHandle: HANDLE, DesiredAccess: DWORD, TokenHandle: *mut HANDLE) -> BOOL;
    fn GetTokenInformation(
        TokenHandle: HANDLE,
        TokenInformationClass: DWORD,
        TokenInformation: *mut c_void,
        TokenInformationLength: DWORD,
        ReturnLength: *mut DWORD,
    ) -> BOOL;
    fn AllocateAndInitializeSid(
        pIdentifierAuthority: *const SID_IDENTIFIER_AUTHORITY,
        nSubAuthorityCount: u8,
        nSubAuthority0: DWORD,
        nSubAuthority1: DWORD,
        nSubAuthority2: DWORD,
        nSubAuthority3: DWORD,
        nSubAuthority4: DWORD,
        nSubAuthority5: DWORD,
        nSubAuthority6: DWORD,
        nSubAuthority7: DWORD,
        pSid: *mut PSID,
    ) -> BOOL;
    fn FreeSid(pSid: PSID) -> *mut c_void;
    fn GetLengthSid(pSid: PSID) -> DWORD;
    fn SetEntriesInAclW(
        cCountOfExplicitEntries: u32,
        pListOfExplicitEntries: *const EXPLICIT_ACCESS_W,
        OldAcl: *const c_void,
        NewAcl: *mut *mut c_void,
    ) -> DWORD;
    fn SetSecurityInfo(
        handle: HANDLE,
        ObjectType: i32,
        SecurityInfo: DWORD,
        psidOwner: PSID,
        psidGroup: PSID,
        pDacl: *const c_void,
        pSacl: *const c_void,
    ) -> DWORD;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn LocalFree(hMem: *mut c_void) -> *mut c_void;
}

struct AllocSid(PSID);
impl Drop for AllocSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { FreeSid(self.0); }
        }
    }
}

struct LocalAcl(*mut c_void);
impl Drop for LocalAcl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0); }
        }
    }
}

unsafe fn current_user_sid_bytes() -> Option<Vec<u8>> {
    let mut token: HANDLE = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut size: DWORD = 0;
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size) };
    if size == 0 {
        unsafe { CloseHandle(token) };
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut c_void,
            size,
            &mut size,
        )
    };
    unsafe { CloseHandle(token) };
    if ok == 0 {
        return None;
    }
    let tu = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    if tu.Sid.is_null() {
        return None;
    }
    let len = unsafe { GetLengthSid(tu.Sid) } as usize;
    let mut out = vec![0u8; len];
    unsafe { core::ptr::copy_nonoverlapping(tu.Sid as *const u8, out.as_mut_ptr(), len) };
    Some(out)
}

pub fn harden(cfg: &PolicyConfig) {
    if !cfg.apply_acl {
        return;
    }
    unsafe {
        let Some(self_sid_bytes) = current_user_sid_bytes() else {
            return;
        };
        let self_sid = self_sid_bytes.as_ptr() as PSID;

        let world_auth = SID_IDENTIFIER_AUTHORITY { Value: SECURITY_WORLD_SID_AUTHORITY };
        let mut everyone: PSID = null_mut();
        if AllocateAndInitializeSid(&world_auth, 1, 0, 0, 0, 0, 0, 0, 0, 0, &mut everyone) == 0 {
            return;
        }
        let _everyone_guard = AllocSid(everyone);

        let nt_auth = SID_IDENTIFIER_AUTHORITY { Value: SECURITY_NT_AUTHORITY };
        let mut system_sid: PSID = null_mut();
        if AllocateAndInitializeSid(
            &nt_auth, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &mut system_sid,
        ) == 0
        {
            return;
        }
        let _system_guard = AllocSid(system_sid);

        let make_ea = |sid: PSID, mask: DWORD, mode: u32, kind: u32| EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: kind,
                ptstrName: sid as LPWSTR,
            },
        };

        // Deny ACEs 必须排在前面。
        let entries = [
            make_ea(everyone, DENY_MASK, DENY_ACCESS, TRUSTEE_IS_WELL_KNOWN_GROUP),
            make_ea(self_sid, PROCESS_ALL_ACCESS, SET_ACCESS, TRUSTEE_IS_USER),
            make_ea(system_sid, PROCESS_ALL_ACCESS, SET_ACCESS, TRUSTEE_IS_WELL_KNOWN_GROUP),
        ];

        let mut new_acl: *mut c_void = null_mut();
        let rc = SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            null(),
            &mut new_acl,
        );
        if rc != 0 || new_acl.is_null() {
            return;
        }
        let _acl_guard = LocalAcl(new_acl);

        let _ = SetSecurityInfo(
            GetCurrentProcess(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_acl,
            null(),
        );

        // _everyone_guard / _system_guard / _acl_guard 走 RAII。
    }
}
