#!/bin/bash
# init.sh — Quest CLI Harness bootstrap script
# Installs Node dependencies, builds TypeScript, and links the `quest` binary globally.
# The dev server is a CLI tool (no HTTP server), so this script just ensures
# the project is compiled and ready for `quest run` invocations.

set -e

echo "==> Installing dependencies..."
npm install 2>&1

echo "==> Building TypeScript..."
npm run build 2>&1

echo "==> Linking quest binary..."
npm link 2>&1 || true

echo ""
echo "Quest CLI is ready."
echo "Usage:"
echo "  quest init <dir>        # Initialize a project"
echo "  quest run [dir]         # Run the full orchestration loop"
echo "  quest resume [dir]      # Resume from last progress"
echo "  quest status [dir]      # Show feature progress"
echo "  quest eval <id> [dir]   # Evaluate a single feature"
echo "  quest feature <id> [dir] # Implement a single feature"
echo "  quest monitor [dir]     # Live TUI dashboard"
