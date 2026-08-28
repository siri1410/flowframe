#!/usr/bin/env sh
# Starts FlowFrame on macOS or Linux. Double-click it, or run ./start.sh
# Everything it does lives in scripts/start.mjs; this is only a way in that does
# not need you to remember a command.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "FlowFrame needs Node 20 or newer. Install it from https://nodejs.org and try again." >&2
  exit 1
fi
exec node scripts/start.mjs "$@"
