# Game Bar companion IPC

The desktop app communicates with the same-package full-trust bridge through
the current-user-only named pipe `MochiPaw.GameBarOverlay`. The bridge connects
to the UWP widget's package-identity-bound AppService
`com.catstack.mochipaw.overlay`.

Every request includes `protocol_version: 1` and a `type`. The AppService
response includes `accepted`; malformed requests, unknown message types,
unsupported versions, and invalid FPS values are rejected.

## Messages

- `set-overlay-session`: sets `enabled`, `target_fps` (`60`, `90`, or `120`),
  `pass_through`, and `model_id`.
- `set-overlay-state`: publishes `active`, target process/window, target
  bounds, minimized state, FPS, and model mode.
- `get-overlay-state`: returns the widget's current package-local state.

Successful replies include the accepted state snapshot. The desktop app
coalesces unchanged window state and refreshes it periodically so normal
foreground-window changes reach the widget without sending a message every
render frame.

The bridge must not expose a network listener. It is packaged with the widget
and the named pipe accepts only clients running as the current Windows user.
Game Bar itself owns pinning and click-through state; the desktop app cannot
force that host-level input mode.
