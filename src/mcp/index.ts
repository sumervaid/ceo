#!/usr/bin/env node
/**
 * stdio entrypoint for the CEO MCP server.
 *
 * stdout belongs to the protocol. Anything this process wants to say to a
 * human goes to stderr, or it corrupts the JSON-RPC stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: unknown) => {
  console.error(`ceo mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
