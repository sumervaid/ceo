#!/usr/bin/env node
/**
 * stdio entrypoint for the `org` MCP server, started by the runner for one
 * agent's run:
 *
 *   node dist/mcp/collab-index.js --agent <name> --root <org directory> [--delegation <id>]
 *
 * stdout belongs to the protocol; anything for a human goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCollabServer } from "./collab.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const agent = arg("--agent");
  const root = arg("--root") ?? process.cwd();
  if (!agent) {
    console.error("ceo org: --agent <name> is required");
    process.exit(2);
  }
  const server = createCollabServer({ agent, root, delegationId: arg("--delegation"), depth: Number(arg("--depth") ?? 0) || 0 });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`ceo org: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
