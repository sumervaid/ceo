import assert from "node:assert/strict";
import { test } from "node:test";

import { smoothFrame } from "./smooth.js";

test("an erase-then-write frame becomes an overwrite in place, wrapped in synchronized output", () => {
  const erase3 = "\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G";
  const out = smoothFrame(`${erase3}one\ntwo\n`);
  assert.equal(out, "\u001b[?2026h\u001b[2A\u001b[Gone\u001b[K\ntwo\u001b[K\n\u001b[J\u001b[?2026l");
  assert.ok(!out.includes("\u001b[2K"), "nothing is blanked before it is redrawn");
  // The first frame has nothing to erase and passes through.
  assert.equal(smoothFrame("first\n"), "first\n");
  assert.equal(smoothFrame("\u001b[?25l"), "\u001b[?25l");
});
