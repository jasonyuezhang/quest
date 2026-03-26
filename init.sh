#!/bin/bash
# init.sh — Development environment setup
# Installs dependencies and starts the API development server.

set -e

echo "==> Installing dependencies..."

# Install Node.js dependencies if package.json exists
if [ -f package.json ]; then
  npm install 2>&1
fi

echo "==> Starting development server..."

# Kill any existing server on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

# Start the API server in the background
node api/server.js &
SERVER_PID=$!

# Wait for server to be ready (up to 10 seconds)
for i in $(seq 1 10); do
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "Development server is running on http://localhost:3000"
    break
  fi
  sleep 1
done

echo ""
echo "Project is ready."
echo "  API server: http://localhost:3000"
echo "  Health check: http://localhost:3000/health"
