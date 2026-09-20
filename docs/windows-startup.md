# Windows startup and administrator relaunch

## Startup registration

The launch-on-startup switch reads Windows registration when Preferences opens.
The saved preference is a display mirror, not an instruction to overwrite an
external change made in Task Manager. Changes are applied only after the native
operation completes; failures are shown and the actual state is read back.

Windows registration uses the existing application value name in the current
user's `Software\Microsoft\Windows\CurrentVersion\Run` key. The executable path
is absolute and quoted, including paths containing spaces or Unicode. On normal
application startup, an existing entry is repaired to the current executable
without changing a Task Manager disable setting. A missing entry stays disabled.
After moving a portable folder, launch the executable once to repair its entry.

Autostart runs at user logon with ordinary user permissions. It does not schedule
an elevated task or remember an in-app administrator relaunch. Windows
compatibility settings that force administrator execution can prevent ordinary
logon startup; those settings should be off when testing normal autostart.
Windows may delay Run entries after logon. Command lines longer than Windows'
documented 260-character limit are rejected with an error.

## Administrator relaunch

The app saves its persistent state first. An asynchronous native command then
requests elevation on a dedicated COM-initialized worker, leaving the application
event loop available while the system prompt is pending. Repeated requests are
rejected until the current attempt finishes. Cancelling elevation keeps the
original application running and lets the existing persistence recovery resume
input collection.

Only successful helper creation requests normal application exit. The elevated
helper still waits for the original process to exit before starting the new
instance with the original arguments. A parent that does not exit in time produces
the existing explicit timeout error; the helper does not open a competing instance
or terminate the old process forcibly.

## Manual acceptance checks

- Install or unpack under a writable path containing spaces and Chinese text.
  Enable startup, reopen Preferences, log out and back in, and verify one working
  instance. Disable startup and repeat logon to verify it remains off.
- With startup enabled, move a portable folder, launch it manually, and inspect
  the Run entry for the new quoted path. Repeat logon.
- Disable the entry in Task Manager. Open the app and Preferences: startup stays
  disabled until explicitly enabled through the switch.
- Relaunch as administrator with both delayed approval and cancellation. The old
  app must keep repainting while waiting; cancellation must preserve operation,
  and approval must yield a single elevated instance after the old one exits.
- Try repeated clicks, normal restart and exit, and arguments containing spaces
  and Unicode. Verify persistent state and typing statistics survive relaunch.

Automated Windows registry tests use a disposable test subtree, never the real
Run key. Native elevation tests use an injected worker action and do not open UAC.
Actual logon and UAC acceptance require an interactive Windows session.

References: [Run and RunOnce registry keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys),
[ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw),
[SHELLEXECUTEINFOW flags](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow).
