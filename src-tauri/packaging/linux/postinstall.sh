#!/bin/sh
set -eu

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now mochi-paw-inputd.service || true
  systemctl is-active --quiet mochi-paw-inputd.service || \
    echo "MochiPaw input service was installed but is not ready." >&2
else
  echo "MochiPaw input service was installed without systemd verification." >&2
fi
