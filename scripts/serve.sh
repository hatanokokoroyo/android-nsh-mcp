#!/usr/bin/env bash
# scripts/serve.sh — MCP stdio 入口（保证 adb 在 PATH 里）
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
exec node "$(cd "$(dirname "$0")/.." && pwd)/src/mcp/server.ts"
