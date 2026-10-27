/**
 * A one-line controlled text input.
 *
 * Written rather than pulled in because the dependency would be larger than
 * the behaviour: a caret, a window that scrolls with it, and a character
 * gate. Everything else a form needs, moving between fields, submitting, and
 * cancelling, belongs to the form, not to the field. The parent's own
 * `useInput` handles it.
 *
 * `useInput` fires in every mounted component, so an unfocused field would
 * otherwise eat the keystrokes meant for its neighbour. The handler is both
 * deactivated through `isActive` and gated by an early return, because a
 * field can lose focus between the event arriving and the handler running.
 */

import { Text, useInput } from "ink";
import { useEffect, useState } from "react";

import { fit } from "../format.js";

export type TextFieldProps = {
  value: string;
  onChange: (next: string) => void;
  /** Shown dim when the value is empty. */
  placeholder?: string;
  /** Only the focused field consumes keystrokes. */
  focused: boolean;
  /** Visible cells for the text itself. Longer values scroll under the caret. */
  width: number;
  /**
   * Per-character gate. A character that fails never enters the value, so a
   * numeric field never has to explain why "abc" was rejected. It never
   * appears. Applied to every character of a paste as well as to keystrokes.
   */
  filter?: (ch: string) => boolean;
};

/** Printable and not a control byte. Guards against pasted escape sequences. */
function isPrintable(ch: string): boolean {
  return ch >= " " && ch !== "\x7f";
}

export function TextField({
  value,
  onChange,
  placeholder = "",
  focused,
  width,
  filter,
}: TextFieldProps) {
  const [cursor, setCursor] = useState(value.length);

  // Focus arrives with the caret at the end of whatever is already there,
  // which is where someone who just tabbed into a pre-filled field expects to
  // continue typing. Deliberately keyed on focus alone: depending on `value`
  // would drag the caret to the end on every keystroke.
  useEffect(() => {
    if (focused) setCursor(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const caret = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      if (!focused) return;

      // Field navigation and submission are the form's, not the field's.
      if (key.tab || key.return || key.escape || key.upArrow || key.downArrow) {
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, caret - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, caret + 1));
        return;
      }

      // Terminals send \x7f for the Backspace key, which ink reports as
      // `delete`. Both mean "remove what I just typed" to the person pressing
      // them, so both delete backwards.
      if (key.backspace || key.delete) {
        if (caret === 0) return;
        onChange(value.slice(0, caret - 1) + value.slice(caret));
        setCursor(caret - 1);
        return;
      }

      if (key.ctrl) {
        if (input === "a") setCursor(0);
        else if (input === "e") setCursor(value.length);
        else if (input === "u") {
          onChange(value.slice(caret));
          setCursor(0);
        } else if (input === "k") {
          onChange(value.slice(0, caret));
        }
        return;
      }

      if (!input) return;
      const accepted = [...input]
        .filter((ch) => isPrintable(ch) && (!filter || filter(ch)))
        .join("");
      if (!accepted) return;
      onChange(value.slice(0, caret) + accepted + value.slice(caret));
      setCursor(caret + accepted.length);
    },
    { isActive: focused },
  );

  const inner = Math.max(4, width);

  if (!focused) {
    return value.length === 0 ? (
      <Text dimColor>{fit(placeholder, inner)}</Text>
    ) : (
      <Text>{fit(value, inner)}</Text>
    );
  }

  if (value.length === 0) {
    return (
      <>
        <Text inverse> </Text>
        <Text dimColor>{fit(placeholder, inner - 1)}</Text>
      </>
    );
  }

  // Scroll the window so the caret is always the last visible cell at worst.
  // Padding to the full width is what gives the caret a cell to occupy when it
  // sits one past the end of the text.
  const start = caret >= inner ? caret - inner + 1 : 0;
  const window = value.slice(start, start + inner).padEnd(inner);
  const at = caret - start;

  return (
    <>
      <Text>{window.slice(0, at)}</Text>
      <Text inverse>{window.slice(at, at + 1)}</Text>
      <Text>{window.slice(at + 1)}</Text>
    </>
  );
}

export default TextField;
