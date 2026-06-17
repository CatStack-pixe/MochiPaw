//! `.text` / `.rdata` / `.pdata` 节代码与只读数据完整性检查(§A4 + §C21)。
//!
//! 资源格式(由 `scripts/embed_text_hash.ts` 在 bundle 前注入到
//! `RT_RCDATA, 0xCA7B`):
//!
//! - **BCSEC v2(§C21,推荐)**:
//!   ```
//!   [u8 magic = 'B','C','S','E','C']     // 5 字节
//!   [u8 sec_count]                        // 节段数
//!   per_section:
//!     [u8 name_len]
//!     [u8 * name_len]                    // ASCII 段名,如 ".text"
//!     [u32 LE page_count]
//!     repeat page_count:
//!       [u32 LE rva][u8;32 sha256]
//!   ```
//!
//! - **v1(§A4 旧版,兼容)**:
//!   `[u32 LE N][rva u32, sha256 [u8;32]] * N`,只校验 `.text`。
//!
//! 资源未注入(无该资源 / 解析失败)时模块自动跳过。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use std::time::Duration;

use rand::{Rng, thread_rng};
use sha2::{Digest, Sha256};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, TEXT_HASH_RESOURCE_ID, exit_code};

const PAGE_SIZE: usize = 4096;
const RT_RCDATA_INTRESOURCE: usize = 10;
const BCSEC_MAGIC: &[u8] = b"BCSEC";

type DWORD = u32;
type HMODULE = *mut c_void;
type HRSRC = *mut c_void;
type HGLOBAL = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> HMODULE;
    fn FindResourceW(module: HMODULE, name: *const u16, ty: *const u16) -> HRSRC;
    fn LoadResource(module: HMODULE, res: HRSRC) -> HGLOBAL;
    fn LockResource(res: HGLOBAL) -> *mut c_void;
    fn SizeofResource(module: HMODULE, res: HRSRC) -> DWORD;
}

#[derive(Debug, Clone, Copy)]
struct PageHash {
    rva: u32,
    hash: [u8; 32],
}

#[derive(Debug, Clone)]
struct SectionRange {
    name: String,
    base: usize,
    rva: u32,
    size: u32,
}

#[derive(Debug, Clone)]
struct SectionEntry {
    name: String,
    range: SectionRange,
    pages: Vec<PageHash>,
    kind: ViolationKind,
    exit_code: u32,
}

unsafe fn find_section(name_prefix: &[u8]) -> Option<SectionRange> {
    let module = unsafe { GetModuleHandleW(core::ptr::null()) };
    if module.is_null() {
        return None;
    }
    let base = module as usize;
    unsafe {
        let e_lfanew = core::ptr::read_unaligned((base + 0x3C) as *const u32) as usize;
        let nt = base + e_lfanew;
        let signature = core::ptr::read_unaligned(nt as *const u32);
        if signature != 0x0000_4550 {
            return None;
        }
        let file_header = nt + 4;
        let num_sections = core::ptr::read_unaligned((file_header + 2) as *const u16) as usize;
        let size_of_optional = core::ptr::read_unaligned((file_header + 16) as *const u16) as usize;
        let optional_header = file_header + 20;
        let mut section = optional_header + size_of_optional;
        for _ in 0..num_sections {
            let name = core::slice::from_raw_parts(section as *const u8, 8);
            let virtual_size = core::ptr::read_unaligned((section + 8) as *const u32);
            let virtual_addr = core::ptr::read_unaligned((section + 12) as *const u32);
            if name.starts_with(name_prefix) {
                let n = name.iter().take_while(|b| **b != 0).count();
                return Some(SectionRange {
                    name: String::from_utf8_lossy(&name[..n]).to_string(),
                    base,
                    rva: virtual_addr,
                    size: virtual_size,
                });
            }
            section += 40;
        }
    }
    None
}

unsafe fn load_resource_bytes() -> Option<&'static [u8]> {
    let module = unsafe { GetModuleHandleW(core::ptr::null()) };
    if module.is_null() {
        return None;
    }
    let res = unsafe {
        FindResourceW(
            module,
            TEXT_HASH_RESOURCE_ID as usize as *const u16,
            RT_RCDATA_INTRESOURCE as *const u16,
        )
    };
    if res.is_null() {
        return None;
    }
    let global = unsafe { LoadResource(module, res) };
    if global.is_null() {
        return None;
    }
    let size = unsafe { SizeofResource(module, res) } as usize;
    let ptr = unsafe { LockResource(global) } as *const u8;
    if ptr.is_null() || size < 4 {
        return None;
    }
    Some(unsafe { core::slice::from_raw_parts(ptr, size) })
}

fn parse_v1(bytes: &[u8]) -> Option<Vec<PageHash>> {
    if bytes.len() < 4 {
        return None;
    }
    let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if n == 0 || bytes.len() < 4 + n * (4 + 32) {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    let mut off = 4usize;
    for _ in 0..n {
        let rva = u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]);
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes[off + 4..off + 36]);
        out.push(PageHash { rva, hash });
        off += 36;
    }
    Some(out)
}

/// 解析 BCSEC v2:返回 (section_name, pages) 列表。
fn parse_v2(bytes: &[u8]) -> Option<Vec<(String, Vec<PageHash>)>> {
    if bytes.len() < 6 || &bytes[..5] != BCSEC_MAGIC {
        return None;
    }
    let sec_count = bytes[5] as usize;
    let mut off = 6usize;
    let mut out = Vec::with_capacity(sec_count);
    for _ in 0..sec_count {
        if off >= bytes.len() {
            return None;
        }
        let name_len = bytes[off] as usize;
        off += 1;
        if off + name_len + 4 > bytes.len() {
            return None;
        }
        let name = String::from_utf8(bytes[off..off + name_len].to_vec()).ok()?;
        off += name_len;
        let page_count = u32::from_le_bytes([
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        ]) as usize;
        off += 4;
        if off + page_count * (4 + 32) > bytes.len() {
            return None;
        }
        let mut pages = Vec::with_capacity(page_count);
        for _ in 0..page_count {
            let rva = u32::from_le_bytes([
                bytes[off],
                bytes[off + 1],
                bytes[off + 2],
                bytes[off + 3],
            ]);
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&bytes[off + 4..off + 36]);
            pages.push(PageHash { rva, hash });
            off += 36;
        }
        out.push((name, pages));
    }
    Some(out)
}

fn kind_for(name: &str) -> (ViolationKind, u32) {
    if name.starts_with(".text") {
        (ViolationKind::TextTampered, exit_code::TEXT_TAMPERED)
    } else if name.starts_with(".rdata") {
        (ViolationKind::RdataTampered, exit_code::RDATA_TAMPERED)
    } else if name.starts_with(".pdata") {
        (ViolationKind::PdataTampered, exit_code::PDATA_TAMPERED)
    } else {
        // 未知段:按 .text 处理(只可能在新版脚本扩段后老 binary 启动出现)
        (ViolationKind::TextTampered, exit_code::TEXT_TAMPERED)
    }
}

fn page_sha256(addr: usize, len: usize) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let bytes = unsafe { core::slice::from_raw_parts(addr as *const u8, len) };
    hasher.update(bytes);
    hasher.finalize().into()
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.integrity_check {
        return;
    }
    let kill = cfg.kill_on_violation;
    let allow_rdata_pdata = cfg.rdata_pdata_integrity;

    let Some(bytes) = (unsafe { load_resource_bytes() }) else {
        return;
    };

    // 优先 v2;失败回退 v1。
    let mut entries: Vec<SectionEntry> = Vec::new();
    if let Some(v2) = parse_v2(bytes) {
        for (name, pages) in v2 {
            // 用户可关闭 .rdata / .pdata 校验(留 .text 始终)
            if !allow_rdata_pdata && (name.starts_with(".rdata") || name.starts_with(".pdata")) {
                continue;
            }
            // 在 PE 节表里查 base + size
            let prefix: Vec<u8> = name.as_bytes().iter().take(8).copied().collect();
            let Some(range) = (unsafe { find_section(&prefix) }) else {
                continue;
            };
            let (kind, ec) = kind_for(&name);
            entries.push(SectionEntry {
                name: range.name.clone(),
                range,
                pages,
                kind,
                exit_code: ec,
            });
        }
    } else if let Some(v1) = parse_v1(bytes) {
        let Some(range) = (unsafe { find_section(b".text") }) else {
            return;
        };
        entries.push(SectionEntry {
            name: range.name.clone(),
            range,
            pages: v1,
            kind: ViolationKind::TextTampered,
            exit_code: exit_code::TEXT_TAMPERED,
        });
    } else {
        return;
    }

    if entries.is_empty() {
        return;
    }

    std::thread::Builder::new()
        .name("self-protect/integrity".into())
        .spawn(move || {
            let mut rng = thread_rng();
            loop {
                // 每轮按页数比例抽样 25%(向上取整,至少 1)
                let total: usize = entries.iter().map(|e| e.pages.len()).sum();
                let sample = ((total as f64) * 0.25).ceil() as usize;
                let sample = sample.max(1);
                for _ in 0..sample {
                    let entry_idx = rng.gen_range(0..entries.len());
                    let e = &entries[entry_idx];
                    if e.pages.is_empty() {
                        continue;
                    }
                    let p_idx = rng.gen_range(0..e.pages.len());
                    let page = e.pages[p_idx];
                    let addr = e.range.base + page.rva as usize;
                    let remain = (e.range.size as usize)
                        .saturating_sub(page.rva as usize - e.range.rva as usize);
                    let len = remain.min(PAGE_SIZE);
                    if len == 0 {
                        continue;
                    }
                    let h = page_sha256(addr, len);
                    if h != page.hash {
                        emit_violation(ViolationEvent::new(
                            e.kind,
                            format!("section={} rva=0x{:X} mismatch", e.name, page.rva),
                        ));
                        kill_self(e.exit_code, kill);
                        return;
                    }
                }
                let jitter = rng.gen_range(0..4_000);
                std::thread::sleep(Duration::from_millis(5_000 + jitter));
            }
        })
        .ok();
}
