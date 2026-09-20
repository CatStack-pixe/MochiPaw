// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::ffi::{OsStr, OsString};

pub const PREPARE_DATA_ARG: &str = "--mochi-paw-prepare-installer-data";

#[derive(Debug, PartialEq, Eq)]
pub enum InstallerUser {
    Sid(String),
    Current,
    Desktop,
}

/// This private installer command accepts an identity, never a filesystem path.
/// Every malformed invocation stays in helper mode instead of starting the UI.
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Option<Result<InstallerUser, String>> {
    let mut args = args.into_iter();
    if args.next().as_deref() != Some(OsStr::new(PREPARE_DATA_ARG)) {
        return None;
    }
    let user = match args.next().as_deref() {
        Some(value) if value == OsStr::new("--current-user") => Ok(InstallerUser::Current),
        Some(value) if value == OsStr::new("--desktop-user") => Ok(InstallerUser::Desktop),
        Some(value) if value == OsStr::new("--user-sid") => args
            .next()
            .and_then(|value| value.into_string().ok())
            .filter(|value| !value.is_empty())
            .map(InstallerUser::Sid)
            .ok_or_else(|| "An explicit Windows user SID is required.".into()),
        _ => Err("Select --user-sid SID, --current-user, or --desktop-user.".into()),
    };
    Some(if args.next().is_some() {
        Err("Unexpected installer data arguments.".into())
    } else {
        user
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strings(args: &[&str]) -> Option<Result<InstallerUser, String>> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn ordinary_launch_arguments_are_not_installer_commands() {
        for args in [
            vec![],
            vec!["--silent"],
            vec!["--mochi-paw-admin-relaunch-helper", "123"],
        ] {
            assert_eq!(parse_strings(&args), None);
        }
    }

    #[test]
    fn installer_commands_select_exactly_one_user_source() {
        assert_eq!(
            parse_strings(&[PREPARE_DATA_ARG, "--current-user"]),
            Some(Ok(InstallerUser::Current))
        );
        assert_eq!(
            parse_strings(&[PREPARE_DATA_ARG, "--desktop-user"]),
            Some(Ok(InstallerUser::Desktop))
        );
        assert_eq!(
            parse_strings(&[PREPARE_DATA_ARG, "--user-sid", "S-1-5-21-1-2-3-1001"]),
            Some(Ok(InstallerUser::Sid("S-1-5-21-1-2-3-1001".into())))
        );
    }

    #[test]
    fn malformed_helper_arguments_never_fall_through_to_the_application() {
        for tail in [
            vec![],
            vec!["--user-sid"],
            vec!["--user-sid", ""],
            vec!["--current-user", "--desktop-user"],
            vec!["--user-sid", "S-1-5-21-1-2-3-1001", "extra"],
            vec!["--path", "C:\\Windows"],
        ] {
            let mut args = vec![PREPARE_DATA_ARG];
            args.extend(tail);
            assert!(parse_strings(&args).unwrap().is_err());
        }
    }
}
