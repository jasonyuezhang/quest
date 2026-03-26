#!/bin/bash
# init.sh — Quest coding agent harness setup script
#
# Installs Node.js dependencies, compiles the TypeScript source,
# and links the CLI globally so `quest` is available as a command.
# This is a CLI tool (no dev server); the compiled output goes to dist/.

set -e

echo "==> Installing Node.js dependencies..."
npm install 2>&1

echo "==> Building TypeScript..."
npm run build 2>&1

echo "==> Linking quest CLI globally..."
npm link 2>&1 || echo "  (npm link skipped — may need sudo or manual PATH setup)"

echo ""
echo "Quest harness ready."
echo "  quest init <project-dir>   — initialize a project"
echo "  quest run  <project-dir>   — run the orchestration loop"
echo "  quest status               — show progress"
echo ""
echo "Dev workflow: npx tsx src/cli.ts <command> [args]"
