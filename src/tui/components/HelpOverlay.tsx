/**
 * Every key, and the one thing the dashboard still cannot do.
 *
 * That last part matters as much as the first. Delegation runs from here,
 * because the dashboard spawns `claude -p`, `codex exec` or `agy -p` itself. Audits
 * still need Claude Code's Agent tool. A key that appeared to run one and
 * quietly did nothing would be worse than no key at all.
 */

import { Box, Text, useInput } from "ink";
import { isEscape } from "../keys.js";

import { fit, wrap } from "../format.js";
import Modal from "./Modal.js";

const KEYS: [string, string][] = [
  ["+", "start a company: a whole team on three providers, hired in one keystroke"],
  ["C", "chat with the chief of staff, who hires and gives out work across providers"],
  ["L", "live view: every agent by provider, and the notes, questions and handoffs between them"],
  ["D", "the docket: give each agent files, issues, Hugging Face cards, pages, notes and skills"],
  ["I", "integrations: GitHub, Hugging Face, alerts and Reflex skills"],
  ["P", "open a pull request for the selected agent's branch, with the ledger's account in the body"],
  ["i", "give the selected agent a worktree and a branch of its own"],
  ["tab", "move focus: workspaces, roster, queue"],
  ["↑ ↓ / j k", "select in the focused panel"],
  ["[ ]", "previous / next workspace"],
  ["w  W", "manage workspaces · pin the sidebar"],
  ["enter", "roster: open the agent · queue: run the task"],
  ["t  e", "add a task to the queue · edit the selected task"],
  ["x  u", "cancel the selected task · requeue a settled one"],
  ["d", "delegate now: queue a task and run it. Spends money"],
  ["R", "dispatch: every idle agent picks up its next queued task"],
  ["A", "auto-dispatch on/off, across every workspace"],
  ["c", "cancel the run on screen"],
  ["n  N", "next / previous run in the pane"],
  ["o", "tmux window with a shell in the agent's worktree"],
  ["h  f", "hire · fire the selected agent"],
  ["p", "suggested team from Reflex workflows, session history and the repo"],
  ["b  y", "budget · cycle autonomy of the selected agent"],
  ["v", "switch the selected agent's provider; brief, budget and history stay"],
  ["m  M", "merge the agent's branch · edit the org's mission"],
  ["S", "setup: are claude and codex installed and signed in; open a login"],
  ["a", "where audits run"],
  ["r", "refresh now"],
  ["esc", "cancel a run, dismiss a finished one, or close what is open"],
  ["q", "quit (ctrl-b d detaches tmux and keeps runs alive)"],
];

const KEY_WIDTH = 11;

export function HelpOverlay({ width, onClose }: { width: number; onClose: () => void }) {
  useInput((input, key) => {
    if (isEscape(input, key) || key.return || input === "?") onClose();
  });

  const inner = Math.max(24, width - 4);

  return (
    <Modal title="Keys" footer="esc close" width={width}>
      {KEYS.map(([k, what]) => (
        <Box key={k}>
          <Text bold>{k.padEnd(KEY_WIDTH)}</Text>
          <Text dimColor>{fit(what, inner - KEY_WIDTH)}</Text>
        </Box>
      ))}

      <Box marginTop={1} flexDirection="column">
        {wrap(
          "A delegation is enforced, not requested. Each agent runs as a headless claude -p or codex exec process. Its autonomy level becomes the control that process applies: a tool allowlist on claude, a filesystem sandbox on codex. Anything it reaches for past that comes back on screen in red. A task is a ledger object. Running it links the task to the delegation that did it.",
          inner,
          4,
        ).map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
        <Text dimColor>
          {fit("Audits still spawn a subagent, which only Claude Code can do:", inner)}
        </Text>
        <Text dimColor>{`  ${fit("/audit", inner - 2)}`}</Text>
      </Box>
    </Modal>
  );
}

export default HelpOverlay;
