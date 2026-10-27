/**
 * The frame every dialog sits in.
 *
 * Ink has no z-axis, so a "modal" here replaces the dashboard rather than
 * floating over it, the same thing the detail view already does. That is
 * also the honest rendering: while a dialog is open the dashboard is not
 * accepting its own keys. A screen that still looked live would be lying
 * about that.
 *
 * The footer is not decoration. Every dialog can be left with esc, and a
 * dialog that does not say so is a trap in a full-screen terminal app.
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { fit } from "../format.js";

export type ModalProps = {
  title: string;
  /** Key legend, rendered dim on the last line. */
  footer: string;
  width: number;
  /** Border colour. Red for anything destructive. */
  color?: string;
  children: ReactNode;
};

export function Modal({ title, footer, width, color = "cyan", children }: ModalProps) {
  const inner = Math.max(20, width - 4);
  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        flexDirection="column"
        width={width}
      >
        <Text bold color={color}>
          {fit(title, inner)}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{fit(footer, inner)}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/** A left-aligned label column, so fields line up down the dialog. */
export function Field({
  label,
  labelWidth,
  focused,
  children,
}: {
  label: string;
  labelWidth: number;
  focused: boolean;
  children: ReactNode;
}) {
  return (
    <Box>
      <Text bold={focused} color={focused ? "cyan" : undefined} dimColor={!focused}>
        {`${focused ? "❯" : " "} ${label.padEnd(labelWidth)} `}
      </Text>
      {children}
    </Box>
  );
}

export default Modal;
