#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Port 8000 is often taken by other local apps on this machine.
PORT="${PORT:-8765}"
exec .venv/bin/uvicorn main:app --reload --host 127.0.0.1 --port "$PORT"
