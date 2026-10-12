#!/bin/bash
# Installs project dependencies at the start of Claude Code cloud sessions,
# which begin from a fresh clone. Does nothing on local machines.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm ci installs exactly what package-lock.json pins and never rewrites it.
npm ci --no-audit --no-fund

# The cloud image ships its own Chromium, which may not match the Playwright
# version in package.json. Both Playwright configs read this variable.
if [ -x /opt/pw-browsers/chromium ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
fi
