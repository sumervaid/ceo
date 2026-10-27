/**
 * Frames without flicker.
 *
 * Ink redraws a frame by erasing every line of the previous one, then
 * writing the new one, in a single write. A large frame reaches the
 * terminal in several chunks, and a terminal that paints between chunks
 * shows the erased screen for an instant. Eight spinner ticks a second make
 * that a visible blink.
 *
 * This filter rewrites the erase. The cursor moves up to the frame's first
 * line, and each new line is written over the old one, clearing only what
 * is left of the old line to its right. Whatever a terminal paints midway
 * is a mix of old and new lines, never an empty screen. The frame is also
 * wrapped in synchronized output, DEC mode 2026, which terminals that
 * support it paint as one. Terminals without it ignore the two sequences.
 *
 * Only the pattern Ink's log-update emits is touched. Anything else passes
 * through unchanged.
 */

const ERASE_UP = "\u001b[2K\u001b[1A";
const FRAME_START = /^((?:\u001b\[2K\u001b\[1A)*)\u001b\[2K\u001b\[G/;
const SYNC_ON = "\u001b[?2026h";
const SYNC_OFF = "\u001b[?2026l";

/** Rewrite one of Ink's erase-then-write frames as an overwrite in place. */
export function smoothFrame(chunk: string): string {
  const m = FRAME_START.exec(chunk);
  if (!m) return chunk;
  const up = m[1].length / ERASE_UP.length;
  const body = chunk.slice(m[0].length).replace(/\n/g, "\u001b[K\n");
  return `${SYNC_ON}${up > 0 ? `\u001b[${up}A` : ""}\u001b[G${body}\u001b[J${SYNC_OFF}`;
}

/** Route a stream's string writes through `smoothFrame`. */
export function installSmoothFrames(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? smoothFrame(chunk) : chunk, ...rest)) as typeof stream.write;
}
