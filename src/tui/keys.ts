/**
 * Key detection that survives coalesced input.
 *
 * Ink's `useInput` sets `key.tab` / `key.return` only when the terminal
 * delivered that control character on its own. Several bytes can arrive in
 * a single read: a fast typist, a paste, or any moment the event loop
 * stalls long enough for stdin to buffer. Ink then passes the whole run as
 * `input` and leaves every key flag false. A form that only checks
 * `key.tab` then silently ignores the tab, and the user watches their
 * cursor refuse to move.
 *
 * That is not a theoretical case. The dashboard shells out to git
 * synchronously while rendering, so a keystroke landing during a worktree
 * read is very likely to be batched with whatever comes next.
 *
 * These helpers check the flag *and* the raw string, so control characters
 * are honoured wherever they turn up. Callers still rely on TextField to
 * filter non-printables out of the text it inserts, so the same chunk can
 * be read as "insert ab" and "then press tab" without conflict.
 */

type InkKey = {
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
  shift?: boolean;
};

/** Tab, whether delivered alone or inside a longer chunk. */
export function isTab(input: string, key: InkKey): boolean {
  return Boolean(key.tab) || input.includes("\t");
}

/** Enter / Return, in either CR or LF form. */
export function isReturn(input: string, key: InkKey): boolean {
  return Boolean(key.return) || input.includes("\r") || input.includes("\n");
}

/**
 * Escape. Deliberately stricter than the others: arrow keys and most
 * function keys are escape *sequences*. Treating any chunk containing
 * \x1b as an escape press would cancel a dialog every time someone pressed
 * an arrow. Only a lone \x1b counts.
 */
export function isEscape(input: string, key: InkKey): boolean {
  return Boolean(key.escape) || input === "\x1b";
}

/**
 * Text left over once control characters are removed, for callers that
 * need to know whether a chunk carried any real typing alongside a tab.
 */
export function printablePart(input: string): string {
  return [...input]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
}
