import type { Bridge, Method, ParamsOf, ResultOf } from "../shared/api";

declare global {
  interface Window {
    ceo: Bridge;
  }
}

export const bridge = window.ceo;
export const desktop = window.ceo.desktop;

/** Calls the engine. Errors arrive with the wrapper Electron adds taken off. */
export async function call<M extends Method>(method: M, ...params: ParamsOf<M> extends undefined ? [] : [ParamsOf<M>]): Promise<Awaited<ResultOf<M>>> {
  try {
    return (await bridge.call(method, params[0] as ParamsOf<M>)) as Awaited<ResultOf<M>>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}
