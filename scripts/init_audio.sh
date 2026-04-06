#!/usr/bin/env bash
set -euo pipefail

# Start PulseAudio in Docker (no systemd). Session sinks are created lazily by Node (pactl load-module).

if ! command -v pulseaudio >/dev/null 2>&1; then
  echo "init_audio: pulseaudio not installed; skipping"
  exit 0
fi

if ! pgrep -x pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 --fail=false || true
  sleep 1
fi

if command -v pactl >/dev/null 2>&1; then
  pactl info >/dev/null 2>&1 || true
fi

exit 0
