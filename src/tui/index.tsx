/**
 * Dashboard entrypoint: `ceo ui`, or `node dist/tui/index.js`.
 *
 * Ink needs a TTY to put the terminal in raw mode for key handling, so a
 * piped or CI invocation is refused up front with a message rather than the
 * raw-mode exception ink would otherwise throw mid-render.
 *
 * Reads of `.ceo/` go through `data.ts`; the four writes the dashboard can
 * perform (hire, fire, budget, merge) go through `actions.ts` and take the
 * ledger lock, so this process and the MCP server can both be running.
 */

import { render } from "ink";
import App from "./components/App.js";
import { installSmoothFrames } from "./smooth.js";

function main(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "The CEO dashboard needs an interactive terminal. Run it directly, not through a pipe.\n",
    );
    process.exitCode = 1;
    return;
  }

  installSmoothFrames(process.stdout);
  // `ceo chat` opens straight onto the conversation with the chief of staff.
  const app = render(<App initialView={process.env.CEO_VIEW === "chat" ? "chat" : undefined} />);
  app.waitUntilExit().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

main();
