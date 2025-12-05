#!/usr/bin/env bash
# Quick test script to verify the server works

cd "$(dirname "$0")"

echo "Starting server..."
bun dev &
SERVER_PID=$!

sleep 2

echo ""
echo "Testing endpoints..."
echo ""

echo "1. Creating a page..."
RESPONSE=$(curl -s -X POST http://localhost:3913/pages/createPage \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Post","content":"Hello world","type":"blog","tags":"tech"}')

PAGE_ID=$(echo $RESPONSE | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$PAGE_ID" ]; then
  echo "✓ Page created with ID: $PAGE_ID"
else
  echo "✗ Failed to create page"
  echo "Response: $RESPONSE"
fi

echo ""
echo "2. Getting all pages..."
PAGES=$(curl -s http://localhost:3913/pages/getPages)
echo "✓ Got pages: $(echo $PAGES | grep -o '"data":\[[^]]*\]')"

echo ""
echo "3. Listing MCP tools..."
TOOLS=$(curl -s -X POST http://localhost:3913/mcp/tools/list)
echo "✓ Got $(echo $TOOLS | grep -o '"name":"[^"]*"' | wc -l | tr -d ' ') tools"

echo ""
echo "Stopping server..."
kill $SERVER_PID 2>/dev/null

echo "Done!"
