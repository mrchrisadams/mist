#!/bin/sh
# Workaround for Deno CJS resolution bug with sub-directory package.json "main" fields.
# react-remove-scroll requires "react-remove-scroll-bar/constants" which uses
# a directory-level package.json with a relative "main" field that Deno can't follow.

CONSTANTS_DIR="node_modules/react-remove-scroll-bar/constants"
SOURCE_FILE="node_modules/react-remove-scroll-bar/dist/es5/constants.js"

if [ -d "$CONSTANTS_DIR" ] && [ -f "$SOURCE_FILE" ]; then
  cp "$SOURCE_FILE" "$CONSTANTS_DIR/index.js"
  cat > "$CONSTANTS_DIR/package.json" << 'EOJSON'
{
  "main": "./index.js"
}
EOJSON
  echo "Patched react-remove-scroll-bar/constants for Deno compatibility"
fi
