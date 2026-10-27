/**
 * Are the agent CLIs installed and signed in?
 *
 * Shown on launch when no provider is ready, and on `S` any time. The
 * dashboard cannot sign anyone in, because both logins are the vendors' own
 * interactive browser flows. So the keys here open a tmux window running
 * the login command, and `r` re-checks when it is done. Without tmux the
 * command to run is printed instead.
 *
 * Billing is on the same card as readiness because it is the question
 * people actually have before the first run: not "will it start" but "whose
 * money". A metered API key is a warning in yellow, not a block.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { reflexStatus } from "../../core/reflex.js";
import { providerFor } from "../../core/providers.js";
import { type Readiness } from "../../core/setup.js";
import type { Provider } from "../../core/types.js";
import { isEscape } from "../keys.js";
import { fit, wrap } from "../format.js";
import Modal from "./Modal.js";

export type SetupScreenProps = {
  readiness: Readiness[];
  width: number;
  /** Open a window running the provider's login. Returns a line for the footer. */
  onLogin: (provider: Provider) => string;
  onRecheck: () => void;
  /** Closing is allowed even when nothing is ready. Hire and run stay blocked. */
  onClose: () => void;
};

export function SetupScreen({ readiness, width, onLogin, onRecheck, onClose }: SetupScreenProps) {
  const [note, setNote] = useState<string | null>(null);
  const inner = Math.max(30, width - 4);
  const anyReady = readiness.some((r) => r.ready);

  useInput((input, key) => {
    if (isEscape(input, key) || (input === "q" && anyReady)) {
      onClose();
      return;
    }
    if (input === "c") setNote(onLogin("claude"));
    if (input === "x") setNote(onLogin("codex"));
    if (input === "g") setNote(onLogin("gemini"));
    if (input === "r") {
      setNote("re-checked");
      onRecheck();
    }
  });

  return (
    <Modal
      title="Set up the agent CLIs"
      footer={`c sign in to claude · x codex · g gemini · r re-check · ${anyReady ? "esc close" : "esc close, agents cannot run yet"}`}
      width={width}
    >
      {wrap(
        "Agents run as headless `claude -p`, `codex exec` and `agy -p` processes under the logins on this machine. Nothing runs until one provider is installed and signed in. Every run bills the account shown here.",
        inner,
        4,
      ).map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}

      {readiness.map((r) => (
        <Card key={r.provider} r={r} width={inner} />
      ))}

      <ReflexCard width={inner} />

      {note ? (
        <Box marginTop={1}>
          <Text color="yellow">{fit(note, inner)}</Text>
        </Box>
      ) : null}
    </Modal>
  );
}

function Card({ r, width }: { r: Readiness; width: number }) {
  const color = r.ready ? "green" : "red";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={color} bold>
          {`${r.ready ? "✓" : "✗"} ${r.provider.padEnd(7)}`}
        </Text>
        <Text color={color}>{r.ready ? "ready" : "not ready"}</Text>
        <Text dimColor>{`  ${r.ready ? providerFor(r.provider).headless : ""}`}</Text>
      </Box>
      <Row label="installed" ok={r.installed} text={r.installed ? r.version ?? "yes" : `no, ${r.binary} not found`} width={width} />
      <Row
        label="signed in"
        ok={r.signedIn}
        text={!r.installed ? "n/a" : r.signedIn ? "yes" : "no"}
        width={width}
      />
      <Box paddingLeft={2}>
        <Text dimColor>{fit(r.billing.summary, width - 2)}</Text>
      </Box>
      {r.ready && r.billing.warning
        ? wrap(r.billing.warning, width - 2, 3).map((line, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color="yellow">{line}</Text>
            </Box>
          ))
        : null}
      {r.fix.map((f, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color="yellow">{fit(`next: ${f}`, width - 2)}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Optional, never a gate: what the suggested team can draw on. */
function ReflexCard({ width }: { width: number }) {
  const rx = reflexStatus();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={rx.scanned ? "green" : undefined} dimColor={!rx.scanned} bold>
          {`${rx.scanned ? "✓" : "·"} reflex  `}
        </Text>
        <Text dimColor>{fit(rx.installed ? (rx.scanned ? "scanned; the suggested team reads it" : "installed, not scanned") : "optional; evidence for the suggested team", width - 12)}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>{fit(rx.summary, width - 2)}</Text>
      </Box>
      {rx.fix ? (
        <Box paddingLeft={2}>
          <Text color="yellow">{fit(`next: ${rx.fix}`, width - 2)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Row({ label, ok, text, width }: { label: string; ok: boolean; text: string; width: number }) {
  return (
    <Box paddingLeft={2}>
      <Text dimColor>{label.padEnd(11)}</Text>
      <Text color={ok ? "green" : "red"}>{fit(text, Math.max(8, width - 13))}</Text>
    </Box>
  );
}

export default SetupScreen;
