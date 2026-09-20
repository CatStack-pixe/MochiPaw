// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Session checks shared by the unprivileged evdev backend and input relay.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub uid: u32,
    pub runtime_dir: PathBuf,
}

#[derive(Debug)]
struct SessionProperties {
    session: Session,
    active: bool,
    graphical: bool,
    remote: bool,
    locked: bool,
}

impl SessionProperties {
    fn permits_input(&self, uid: Option<u32>) -> bool {
        self.active
            && self.graphical
            && !self.remote
            && !self.locked
            && uid.is_none_or(|uid| self.session.uid == uid)
    }
}

fn parse_session_properties(output: &str) -> Result<SessionProperties, String> {
    let fields: HashMap<_, _> = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    let required = |name: &str| {
        fields
            .get(name)
            .copied()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("loginctl did not return session property {name}"))
    };
    let boolean = |name| match required(name)? {
        "yes" => Ok(true),
        "no" => Ok(false),
        _ => Err(format!("loginctl returned an invalid {name} property")),
    };
    let uid = required("User")?
        .parse::<u32>()
        .map_err(|_| "loginctl returned an invalid session user".to_string())?;
    Ok(SessionProperties {
        session: Session {
            id: required("Id")?.to_owned(),
            uid,
            runtime_dir: PathBuf::from(format!("/run/user/{uid}")),
        },
        active: boolean("Active")?,
        graphical: matches!(required("Type")?, "wayland" | "x11"),
        remote: boolean("Remote")?,
        locked: boolean("LockedHint")?,
    })
}

fn loginctl(args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("loginctl")
        .args(args)
        .arg("--no-pager")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to inspect the graphical login session: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                thread::sleep(Duration::from_millis(10));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => {
                        format!("failed to wait for graphical session information: {error}")
                    }
                    _ => "graphical login session validation timed out".into(),
                });
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to read graphical login session information: {error}"))?;
    if !output.status.success() {
        return Err("loginctl could not validate the graphical login session".into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| "loginctl returned invalid session information".into())
}

fn inspect_session(id: &str) -> Result<SessionProperties, String> {
    parse_session_properties(&loginctl(&[
        "show-session",
        id,
        "--property=Id",
        "--property=Active",
        "--property=Type",
        "--property=User",
        "--property=Remote",
        "--property=LockedHint",
    ])?)
}

fn session_ids() -> Result<Vec<String>, String> {
    Ok(loginctl(&["list-sessions", "--no-legend"])?
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
        .collect())
}

/// Returns the active, unlocked, local graphical session served by inputd.
pub fn active_graphical_session() -> Result<Session, String> {
    for id in session_ids()? {
        // Sessions can disappear between enumeration and inspection.
        if let Ok(properties) = inspect_session(&id) {
            if properties.permits_input(None) && properties.session.runtime_dir.is_dir() {
                return Ok(properties.session);
            }
        }
    }
    Err("no active, unlocked local graphical login session is available".into())
}

/// Whether this process belongs to an active, unlocked local graphical session.
/// A known inactive session must never fall back to a different session of the UID.
pub fn current_user_session_active() -> Result<bool, String> {
    let uid = unsafe { libc::geteuid() };
    if let Ok(id) = std::env::var("XDG_SESSION_ID") {
        if !id.is_empty() {
            if let Ok(properties) = inspect_session(&id) {
                return Ok(properties.permits_input(Some(uid)));
            }
        }
    }
    if let Ok(properties) = inspect_session("self") {
        return Ok(properties.permits_input(Some(uid)));
    }
    // User services may have no process-associated session, including launches
    // from desktop launchers, so inspect the user's logind sessions.
    for id in session_ids()? {
        if let Ok(properties) = inspect_session(&id) {
            if properties.permits_input(Some(uid)) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTIVE: &str = "User=1000\nLockedHint=no\nType=wayland\nId=3\nRemote=no\nActive=yes\n";

    #[test]
    fn parses_named_properties_independently_of_output_order() {
        let properties = parse_session_properties(ACTIVE).unwrap();
        assert_eq!(properties.session.id, "3");
        assert_eq!(
            properties.session.runtime_dir,
            PathBuf::from("/run/user/1000")
        );
        assert!(properties.permits_input(Some(1000)));
        assert!(!properties.permits_input(Some(1001)));
    }

    #[test]
    fn excludes_locked_inactive_remote_and_text_sessions() {
        for (from, to) in [
            ("LockedHint=no", "LockedHint=yes"),
            ("Active=yes", "Active=no"),
            ("Remote=no", "Remote=yes"),
            ("Type=wayland", "Type=tty"),
        ] {
            let properties = parse_session_properties(&ACTIVE.replace(from, to)).unwrap();
            assert!(!properties.permits_input(None), "{to}");
        }
    }

    #[test]
    fn fails_closed_for_missing_or_invalid_properties() {
        for output in [
            ACTIVE.replace("LockedHint=no\n", ""),
            ACTIVE.replace("User=1000", "User=unknown"),
            ACTIVE.replace("Active=yes", "Active=unknown"),
            ACTIVE.replace("Id=3", "Id="),
        ] {
            assert!(parse_session_properties(&output).is_err());
        }
    }

    #[test]
    fn session_identity_distinguishes_sessions_of_the_same_user() {
        let first = parse_session_properties(ACTIVE).unwrap().session;
        let second = parse_session_properties(&ACTIVE.replace("Id=3", "Id=4"))
            .unwrap()
            .session;
        assert_ne!(first, second);
    }
}
