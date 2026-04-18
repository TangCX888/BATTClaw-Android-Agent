#!/bin/bash

__filepath="$(cd "$(dirname "$0")" && pwd)"

cd "$__filepath" || { echo "cannot found directory" ; exit 1 ;}

DOTENV_CONFIG_QUIET=true npx tsx src/modules/mcp/mcpServer.ts