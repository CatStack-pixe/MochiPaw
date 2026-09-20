#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 InfinityXCat
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Build and exercise isolated Windows installers with real restricted-token I/O.

Run ``build`` followed by ``run`` in an elevated Windows terminal. The test uses
unique product, executable, component and upgrade identities; it never starts
the GUI or touches an existing MochiPaw installation. Installer logs and the
evidence report are written below target/installer-data-smoke.
"""

import argparse
import contextlib
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET


REPO = Path(__file__).resolve().parent.parent
STATE = REPO / "target" / "installer-data-smoke"
PREFIX = "MochiPawInstallerSmoke-"
EVENTS = []


def record(message):
    print(message, flush=True)
    EVENTS.append(message)
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "evidence.json").write_text(
        json.dumps(EVENTS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def command(args, *, timeout=300, allowed=(0,), env=None):
    record("Run: " + (args if isinstance(args, str) else subprocess.list2cmdline(args)))
    result = subprocess.run(args, cwd=REPO, timeout=timeout, env=env, check=False)
    record(f"Exit code: {result.returncode}")
    if result.returncode not in allowed:
        raise RuntimeError(f"Command failed with exit code {result.returncode}")


def build():
    STATE.mkdir(parents=True, exist_ok=True)
    nonce = uuid.uuid4()
    name = PREFIX + nonce.hex
    windows_config = json.loads(
        (REPO / "src-tauri" / "tauri.windows.conf.json").read_text(encoding="utf-8")
    )
    # A permanent component GUID must also be isolated from production products.
    fragments = []
    namespace = "http://schemas.microsoft.com/wix/2006/wi"
    ET.register_namespace("", namespace)
    for index, source in enumerate(windows_config["bundle"]["windows"]["wix"]["fragmentPaths"]):
        tree = ET.parse(REPO / "src-tauri" / source)
        for component in tree.findall(f".//{{{namespace}}}Component"):
            component.set("Guid", str(uuid.uuid5(nonce, component.attrib["Id"])))
        destination = STATE / f"fixture-{index}.wxs"
        tree.write(destination, encoding="utf-8", xml_declaration=True)
        fragments.append(str(destination))
    config = {
        "productName": name,
        "mainBinaryName": name,
        "identifier": "com.catstack.mochipaw.installer-smoke." + nonce.hex,
        "bundle": {
            "createUpdaterArtifacts": False,
            "windows": {
                # Remove the inherited bootstrapper-only option through JSON Merge Patch.
                "webviewInstallMode": {"type": "skip", "silent": None},
                "minimumWebview2Version": None,
                "wix": {
                    "upgradeCode": str(uuid.uuid4()),
                    "language": "en-US",
                    "fragmentPaths": fragments,
                },
                "nsis": {
                    "installMode": "perMachine",
                    "languages": ["English"],
                    "displayLanguageSelector": False,
                },
            },
        },
    }
    config_path = STATE / "config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    # Use the workspace target directory so the following run step finds only
    # this build's packages, irrespective of a caller's shared Rust cache path.
    env = dict(os.environ, CARGO_TARGET_DIR=str(REPO / "target"))
    command(
        ["node", "node_modules/@tauri-apps/cli/tauri.js", "build", "--debug",
         "--bundles", "msi,nsis", "--config", str(config_path), "--", "--locked"],
        timeout=1800, env=env,
    )
    record(f"Built isolated MSI and NSIS packages for {name}")


class WindowsAccess:
    """Minimal Win32 bindings; no account creation, credentials or child tokens."""

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    def __init__(self):
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel.LocalFree.argtypes = [ctypes.c_void_p]
        self.kernel.LocalFree.restype = ctypes.c_void_p
        self.advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        self.advapi.OpenProcessToken.restype = wintypes.BOOL
        self.advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        self.advapi.GetTokenInformation.restype = wintypes.BOOL
        self.advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
        self.advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
        self.advapi.CreateWellKnownSid.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
        self.advapi.CreateWellKnownSid.restype = wintypes.BOOL
        self.advapi.CreateRestrictedToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(self.SidAndAttributes), wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.HANDLE)]
        self.advapi.CreateRestrictedToken.restype = wintypes.BOOL
        self.advapi.ImpersonateLoggedOnUser.argtypes = [wintypes.HANDLE]
        self.advapi.ImpersonateLoggedOnUser.restype = wintypes.BOOL
        self.advapi.RevertToSelf.argtypes = []
        self.advapi.RevertToSelf.restype = wintypes.BOOL
        self.advapi.CheckTokenMembership.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL)]
        self.advapi.CheckTokenMembership.restype = wintypes.BOOL
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
        self.advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
        self.advapi.SetFileSecurityW.restype = wintypes.BOOL
        self.original = wintypes.HANDLE()
        self.restricted = wintypes.HANDLE()
        self.admin_sid = ctypes.create_string_buffer(68)
        sid_size = wintypes.DWORD(len(self.admin_sid))
        self.check(self.advapi.CreateWellKnownSid(26, None, self.admin_sid, ctypes.byref(sid_size)))
        if not self.is_admin():
            raise RuntimeError("Installer smoke requires an elevated Windows terminal")
        self.check(self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x000A, ctypes.byref(self.original)))
        try:
            disabled = self.SidAndAttributes(ctypes.cast(self.admin_sid, ctypes.c_void_p), 0)
            # DISABLE_MAX_PRIVILEGE removes privileges (except traversal); the
            # Administrators SID becomes deny-only. The user SID is unchanged.
            self.check(self.advapi.CreateRestrictedToken(self.original, 1, 1, ctypes.byref(disabled), 0, None, 0, None, ctypes.byref(self.restricted)))
            self.user_sid = self.current_sid()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def check(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())

    def is_admin(self):
        member = wintypes.BOOL()
        self.check(self.advapi.CheckTokenMembership(None, self.admin_sid, ctypes.byref(member)))
        return bool(member.value)

    def current_sid(self):
        size = wintypes.DWORD()
        self.advapi.GetTokenInformation(self.original, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        self.check(self.advapi.GetTokenInformation(self.original, 1, buffer, len(buffer), ctypes.byref(size)))
        token_user = ctypes.cast(buffer, ctypes.POINTER(self.SidAndAttributes)).contents
        text = wintypes.LPWSTR()
        self.check(self.advapi.ConvertSidToStringSidW(token_user.Sid, ctypes.byref(text)))
        try:
            return text.value
        finally:
            self.kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    @contextlib.contextmanager
    def ordinary_user(self):
        self.check(self.advapi.ImpersonateLoggedOnUser(self.restricted))
        try:
            if self.is_admin():
                raise AssertionError("Restricted token still has administrator membership")
            yield
        finally:
            self.check(self.advapi.RevertToSelf())

    def protect_fixture_root(self, directory):
        descriptor = ctypes.c_void_p()
        # Explicit DACL avoids an inherited CREATOR OWNER grant invalidating
        # the test when the elevated and restricted tokens share a user SID.
        self.check(self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)",
            1, ctypes.byref(descriptor), None,
        ))
        try:
            self.check(self.advapi.SetFileSecurityW(str(directory), 0x80000004, descriptor))
        finally:
            self.kernel.LocalFree(descriptor)

    def close(self):
        for handle in (self.restricted, self.original):
            if handle:
                self.kernel.CloseHandle(handle)


def scoped(path, root):
    resolved = path.resolve()
    anchor = root.resolve()
    if resolved != anchor and anchor not in resolved.parents:
        raise AssertionError(f"Path is outside smoke fixture: {resolved}")
    # Reject junctions and symlinks before recursive ACL or cleanup operations.
    for candidate in [path, *path.parents]:
        if candidate.exists() and candidate.lstat().st_file_attributes & 0x400:
            raise AssertionError(f"Reparse point in smoke fixture path: {candidate}")
        if candidate == root:
            break
    return resolved


def denied(operation, description):
    try:
        operation()
    except PermissionError:
        return
    raise AssertionError(f"Restricted token unexpectedly allowed {description}")


def open_write(path):
    # Request write access without changing executable bytes, even on failure.
    with path.open("r+b"):
        pass


def verify_access(access, directory, executable):
    data = directory / "data"
    with access.ordinary_user():
        denied(lambda: (directory / "root-write-probe.tmp").write_bytes(b"probe"), "install-root creation")
        denied(lambda: open_write(executable), "executable modification")
        nested = data / "ordinary-user-probe" / "nested"
        nested.mkdir(parents=True)
        probe = nested / "settings.json"
        probe.write_text('{"value":1}', encoding="utf-8")
        probe.write_text('{"value":2}', encoding="utf-8")
        moved = probe.rename(nested / "renamed.json")
        if moved.read_text(encoding="utf-8") != '{"value":2}':
            raise AssertionError("Restricted-token data read differs from write")
        moved.unlink()
        nested.rmdir()
        nested.parent.rmdir()
    record(f"PASS {directory.name}: ordinary user data create/modify/rename/delete; root and executable writes denied")


def read_sentinels(paths):
    return {str(path): path.read_bytes() for path in paths}


def find_package(name, kind, extension):
    packages = list((REPO / "target" / "debug" / "bundle" / kind).glob(name + "_*" + extension))
    if len(packages) != 1:
        raise RuntimeError(f"Expected one isolated {kind} package, found {packages}")
    return packages[0].resolve()


def exercise(access, root, name, kind):
    directory = scoped(root / (kind.upper() + " 中文安装"), root)
    executable = directory / (name + ".exe")
    package = find_package(name, kind, ".msi" if kind == "msi" else ".exe")
    installed = False
    uninstalled = False

    def msi(action, label, extra=()):
        command(["msiexec.exe", action, str(package), "/qn", "/norestart",
                 "/L*V", str(STATE / (label + ".log")), *extra], allowed=(0, 3010))

    def install(repair=False):
        if kind == "msi":
            msi("/fa" if repair else "/i", "msi-repair" if repair else "msi-install",
                [f"INSTALLDIR={directory}", "ALLUSERS=1"])
        else:
            # NSIS requires /D as the final argument without quotes. The raw
            # command is passed directly to CreateProcess (never a shell).
            prefix = subprocess.list2cmdline([str(package), "/S", f"/MOCHIPAW_USER_SID={access.user_sid}"])
            command(prefix + " /D=" + str(directory))

    def uninstall():
        if kind == "msi":
            msi("/x", "msi-uninstall")
        else:
            uninstallers = list(directory.glob("*ninstall*.exe"))
            if len(uninstallers) != 1:
                raise RuntimeError(f"Expected one NSIS uninstaller, found {uninstallers}")
            # _?= prevents the asynchronous temporary uninstaller copy, so the
            # process exit really means uninstall has completed.
            command(subprocess.list2cmdline([str(uninstallers[0]), "/S"]) + " _?=" + str(directory))

    try:
        install()
        installed = True
        if not executable.is_file() or not (directory / "data").is_dir():
            raise AssertionError(f"{kind} did not create the executable and data directory")
        verify_access(access, directory, executable)
        sentinels = [directory / "data" / "settings.json", directory / "data" / "models" / "custom.json"]
        with access.ordinary_user():
            for index, path in enumerate(sentinels):
                path.parent.mkdir(exist_ok=True)
                path.write_text(json.dumps({"keep": name, "model": index}), encoding="utf-8")
        expected = read_sentinels(sentinels)
        # Recreate the old installer problem: inherited Program Files ACLs on
        # both data and existing nested settings/model files, no user grant.
        data = scoped(directory / "data", root)
        command(["icacls.exe", str(data), "/reset", "/T", "/Q"])
        with access.ordinary_user():
            denied(lambda: open_write(sentinels[0]), "old inherited data ACL")
        record(f"PASS {kind}: reproduced inaccessible existing data before repair")
        install(repair=True)
        if read_sentinels(sentinels) != expected:
            raise AssertionError(f"{kind} reinstall changed existing settings or custom models")
        verify_access(access, directory, executable)
        with access.ordinary_user():
            for path in sentinels:
                original = path.read_bytes()
                path.write_bytes(original + b"\n")
                path.write_bytes(original)
        record(f"PASS {kind}: reinstall/repair restored existing nested file writes and preserved settings/models")
        uninstall()
        uninstalled = True
        if executable.exists() or read_sentinels(sentinels) != expected:
            raise AssertionError(f"{kind} uninstall failed to remove the program or preserve user data")
        record(f"PASS {kind}: uninstall removed executable and retained user data")
    finally:
        if installed and not uninstalled:
            try:
                uninstall()
            except Exception as error:
                record(f"Cleanup uninstall failed for {kind}: {error}")


def run():
    config = json.loads((STATE / "config.json").read_text(encoding="utf-8"))
    name = config["productName"]
    if not re.fullmatch(PREFIX + r"[0-9a-f]{32}", name) or config["mainBinaryName"] != name:
        raise RuntimeError("Expected an isolated smoke configuration; run build first")
    program_files = Path(os.environ["ProgramFiles"]).resolve()
    root = program_files / name
    if root.exists():
        raise RuntimeError(f"Smoke root already exists: {root}; build a new isolated fixture")
    access = WindowsAccess()
    try:
        root.mkdir()
        access.protect_fixture_root(root)
        record(f"Fixture: {root}; intended user: {access.user_sid}")
        for kind in ("msi", "nsis"):
            exercise(access, root, name, kind)
        record("PASS all real installer data-access checks")
    finally:
        access.close()
        # Delete only the exact nonce-named child of Program Files created above.
        if root.parent.resolve() != program_files or root.name != name:
            raise AssertionError("Unexpected smoke cleanup target")
        if root.exists():
            scoped(root, root)
            for child in root.rglob("*"):
                scoped(child, root)
            shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "run"))
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("This integration test requires Windows")
    try:
        (build if args.action == "build" else run)()
    except Exception as error:
        record(f"FAIL: {error}")
        raise


if __name__ == "__main__":
    main()
