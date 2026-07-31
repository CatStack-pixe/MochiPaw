#!/bin/sh
set -eu

systemctl disable --now mochi-paw-inputd.service || true
