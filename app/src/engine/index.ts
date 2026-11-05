/** The engine process. Messages in, results and events out. */
import type { EngineEvent, Method } from "../shared/api";
import { createEngine } from "./engine";

type Port = { on(ev: "message", cb: (e: { data: { id: number; method: Method; params: unknown } }) => void): void; postMessage(m: unknown): void };
const port = (process as unknown as { parentPort: Port }).parentPort;

const { handlers, dispose } = createEngine((event: EngineEvent) => port.postMessage({ event }));

port.on("message", async ({ data }) => {
  const { id, method, params } = data;
  try {
    const fn = handlers[method] as (p: unknown) => unknown;
    if (!fn) throw new Error(`Unknown call: ${method}`);
    port.postMessage({ id, result: await fn(params) });
  } catch (e) {
    port.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});

process.on("SIGTERM", () => {
  dispose();
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  process.stderr.write(`engine: ${e.stack ?? e.message}\n`);
});
