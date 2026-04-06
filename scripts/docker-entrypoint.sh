#!/usr/bin/env bash
set -euo pipefail
/usr/local/bin/init_audio.sh
exec "$@"
