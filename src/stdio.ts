#!/usr/bin/env node
// Local entry for Claude Desktop / Claude Code: `node dist/stdio.js`.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./tools.js";

await buildServer().connect(new StdioServerTransport());
