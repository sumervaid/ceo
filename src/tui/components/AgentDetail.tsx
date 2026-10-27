/**
 * Full-screen view of one agent.
 *
 * The dashboard answers "is anything wrong". This view answers "what has this
 * agent actually been doing, and what is it allowed to do". Five blocks: the
 * brief it was hired on, the configuration it runs under, what it has spent,
 * what it has been asked to do lately, and, for isolated agents, whether
 * its branch has work sitting on it that nobody has merged.
 *
 * The configuration block exists because every part of it is invisible in the
 * agent's output. An agent at `observe` and an agent at `autonomous` produce
 * the same kind of text. The difference only shows up in what landed on disk
 * afterwards. Same for a systemPrompt override. It silently removes the
 * mission and every guardrail from the prompt, while leaving both of them
 * sitting in the roster looking as if they applied.
 *
 * Worktree state is a git shell-out, so it is read once when the view opens
 * rather than on every dashboard refresh. Switching agents re-reads it.
 */

import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";

import { policyFor } from "../../core/autonomy.js";
import { providerFor } from "../../core/providers.js";
import { enforcementFor } from "../../core/runner.js";
import type { AgentRecord, Mission } from "../../core/types.js";
import { readWorktreeInfo, type Delegation, type WorktreeInfo } from "../data.js";
import {
  autonomyColor,
  autonomyLevel,
  budgetLevel,
  budgetRatio,
  clock,
  compactBudget,
  compactUsd,
  fit,
  levelColor,
  meter,
  providerColor,
  secs,
  shortModel,
  sinceHuman,
  stamp,
  usdExact,
  wrap,
} from "../format.js";

const METER_WIDTH = 24;
const MAX_DELEGATIONS = 8;
const MAX_CHANGED_FILES = 6;
const MAX_UNMERGED = 4;
const MAX_GUARDRAILS = 6;

export type AgentDetailProps = {
  agent: AgentRecord;
  /** The whole feed; filtered to this agent here. */
  delegations: Delegation[];
  /** Needed to mark which of this agent's guardrails it did not choose. */
  mission: Mission | null;
  /** Workspace root, so worktree state is read from the right repo. */
  cwd?: string;
  width: number;
  height: number;
};

export function AgentDetail({
  agent,
  delegations,
  mission,
  cwd,
  width,
  height,
}: AgentDetailProps) {
  // Keyed by agent name so switching agents shows the loading line instead of
  // the previous agent's git state. React batches the two setStates otherwise.
  const [worktree, setWorktree] = useState<{ agent: string; info: WorktreeInfo } | null>(
    null,
  );

  useEffect(() => {
    setWorktree({ agent: agent.name, info: readWorktreeInfo(agent, cwd) });
  }, [agent.name, agent.isolated, agent.worktreePath, cwd]);

  const worktreeInfo = worktree?.agent === agent.name ? worktree.info : null;

  const level = budgetLevel(agent.spentUsd, agent.budgetUsd);
  const color = levelColor(level);
  const bar = meter(budgetRatio(agent.spentUsd, agent.budgetUsd), METER_WIDTH);
  const inner = Math.max(10, width - 4);

  const mine = delegations.filter((d) => d.agent === agent.name);
  const avg =
    agent.delegations > 0 ? agent.spentUsd / agent.delegations : 0;

  // Role briefs are free text and can run long. Give them a bounded share of
  // the screen rather than letting one push the spend history off the bottom.
  // The configuration block below costs several lines, so the brief's share
  // shrank when it arrived.
  const briefLines = wrap(agent.role, inner, Math.max(2, Math.min(4, height - 26)));

  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text bold color={color}>
            {agent.name}
          </Text>
          <Text color={providerColor(agent.provider)}>{`  ${agent.provider ?? "claude"}`}</Text>
          <Text dimColor>{` ${shortModel(agent.model)}`}</Text>
          {agent.isolated ? (
            <Text color="cyan">{`  ⎇ ${agent.branch ?? "(not provisioned)"}`}</Text>
          ) : (
            <Text dimColor>{"  main tree"}</Text>
          )}
        </Box>

        <Box>
          <Text color={color}>{bar.filled}</Text>
          <Text dimColor>{bar.empty}</Text>
          <Text color={color}>{`  ${usdExact(agent.spentUsd)}`}</Text>
          <Text dimColor>{` of ${compactBudget(agent.budgetUsd)}`}</Text>
          {level === "over" ? (
            <Text color="red" bold>
              {"  OVER BUDGET"}
            </Text>
          ) : null}
        </Box>

        <Box>
          <Text dimColor>{`${agent.delegations} delegations · ${compactUsd(avg)} avg · last active ${sinceHuman(agent.lastActiveAt)} ago · hired ${stamp(agent.hiredAt)}`}</Text>
        </Box>
      </Box>

      <Section title="Brief">
        {briefLines.length > 0 ? (
          briefLines.map((line, i) => <Text key={i}>{line}</Text>)
        ) : (
          <Text dimColor>(no brief recorded)</Text>
        )}
        {agent.tools.length > 0 ? (
          <Text dimColor>{fit(`Tools: ${agent.tools.join(", ")}`, inner)}</Text>
        ) : (
          <Text dimColor>Tools: inherits defaults</Text>
        )}
      </Section>

      <Section title="Configuration">
        <ConfigBlock agent={agent} mission={mission} width={inner} />
      </Section>

      <Section title={`Recent delegations (${mine.length})`}>
        {mine.length === 0 ? (
          <Text dimColor>Nothing delegated to this agent yet.</Text>
        ) : (
          mine.slice(0, MAX_DELEGATIONS).map((d) => (
            <Box key={`${d.id}-${d.ts}`}>
              <Text dimColor>{`${clock(d.ts)} `}</Text>
              <Text color={d.complete ? "green" : "yellow"}>
                {d.complete ? "✓ " : "⋯ "}
              </Text>
              <Text>
                {d.complete
                  ? `${compactUsd(d.costUsd).padEnd(8)}${secs(d.durationMs).padEnd(8)}`
                  : "running         "}
              </Text>
              <Text dimColor>{fit(d.task, Math.max(0, inner - 27))}</Text>
            </Box>
          ))
        )}
      </Section>

      <Section title="Worktree">
        <WorktreeBlock info={worktreeInfo} width={inner} />
      </Section>

      <Box paddingX={1}>
        <Text dimColor>
          esc back · ↑↓ other agents · y autonomy · v provider · b budget · m merge · f fire · ? help · q quit
        </Text>
      </Box>
    </Box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold dimColor>
        {title}
      </Text>
      {children}
    </Box>
  );
}

/**
 * What this agent runs under: its permission level, the rules it cannot
 * break, how it is meant to work with the others, and whether any of that is
 * actually reaching it.
 *
 * The override warning is the reason this block is not just three dim lines.
 * `compileAgentPrompt` returns early on a systemPrompt, dropping the mission,
 * the collaboration brief, the autonomy wording, and every guardrail from the
 * text the agent sees. The tool allowlist still applies, because autonomy is
 * enforced outside the prompt. Everything else on this screen becomes
 * decoration. A screen that keeps displaying decoration as if it were
 * configuration is how someone ends up trusting a guardrail that was never
 * sent.
 */
function ConfigBlock({
  agent,
  mission,
  width,
}: {
  agent: AgentRecord;
  mission: Mission | null;
  width: number;
}) {
  const level = autonomyLevel(agent.autonomy);
  const policy = policyFor(level);
  const color = autonomyColor(level);
  const spec = providerFor(agent.provider);
  const grants = enforcementFor(agent);
  const overridden = Boolean(agent.systemPrompt?.trim());

  // Case-insensitive, matching how compileAgentPrompt dedupes the two lists.
  const orgRails = new Set(
    (mission?.orgGuardrails ?? []).map((g) => g.trim().toLowerCase()),
  );
  const own = (agent.guardrails ?? []).filter(Boolean);
  const rails = [
    ...(mission?.orgGuardrails ?? []).map((text) => ({ text, inherited: true })),
    ...own
      .filter((g) => !orgRails.has(g.trim().toLowerCase()))
      .map((text) => ({ text, inherited: false })),
  ];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold>
          {level}
        </Text>
        <Text dimColor>{`: ${fit(policy.label, Math.max(4, width - level.length - 3))}`}</Text>
      </Box>
      <Text dimColor>
        {fit(
          `may write: ${policy.canWrite ? "yes" : "no"} · may merge unattended: ${
            policy.canMerge ? "yes" : "no"
          }`,
          width,
        )}
      </Text>
      {/* How the level is enforced, which differs by provider: a tool
          allowlist on claude, a sandbox on codex. Both are applied by the
          child process. Neither is prompt wording. */}
      <Text dimColor>
        {fit(`enforced by ${spec.label}: ${spec.enforcementLabel(level, agent.tools ?? [])}`, width)}
      </Text>
      <Text dimColor>{fit(`grants: ${grants.length > 0 ? grants.join(", ") : "none"}`, width)}</Text>

      <Box marginTop={1} flexDirection="column">
        {rails.length === 0 ? (
          <Text dimColor>Guardrails: none, from the org or its own.</Text>
        ) : (
          <>
            <Text dimColor>{`Guardrails (${rails.length})`}</Text>
            {rails.slice(0, MAX_GUARDRAILS).map((r, i) => (
              <Box key={`${i}-${r.text}`}>
                <Text color={r.inherited ? "yellow" : "cyan"}>
                  {r.inherited ? "  org  " : "  own  "}
                </Text>
                <Text dimColor={overridden}>{fit(r.text, Math.max(4, width - 7))}</Text>
              </Box>
            ))}
            {rails.length > MAX_GUARDRAILS ? (
              <Text dimColor>{`  +${rails.length - MAX_GUARDRAILS} more`}</Text>
            ) : null}
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {agent.collaboration?.trim() ? (
          <>
            <Text dimColor>Collaboration</Text>
            {wrap(agent.collaboration, width - 2, 3).map((line, i) => (
              <Text key={i} dimColor={overridden}>{`  ${line}`}</Text>
            ))}
          </>
        ) : (
          <Text dimColor>
            {fit(
              "Collaboration: none set, so this agent has no instruction about who it defers to.",
              width,
            )}
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {overridden ? (
          <>
            <Text color="red" bold>
              {fit("systemPrompt override in effect", width)}
            </Text>
            {wrap(
              "The mission, the guardrails above, and the collaboration brief are NOT reaching this agent. The override replaces all of them. Only the autonomy tool allowlist still applies, because that is enforced outside the prompt.",
              width,
              4,
            ).map((line, i) => (
              <Text key={i} color="red">
                {line}
              </Text>
            ))}
          </>
        ) : (
          <Text dimColor>
            {fit("No systemPrompt override · running the compiled prompt.", width)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function WorktreeBlock({ info, width }: { info: WorktreeInfo | null; width: number }) {
  if (!info) return <Text dimColor>reading git state…</Text>;
  if (!info.isolated) {
    return (
      <Text dimColor>
        Not isolated. This agent works in the main tree, so its edits are not
        separated from yours.
      </Text>
    );
  }
  if (info.error) return <Text color="red">{fit(info.error, width)}</Text>;

  return (
    <Box flexDirection="column">
      <Text dimColor>{fit(info.path ?? "(no worktree path recorded)", width)}</Text>

      {info.changed.length === 0 ? (
        <Text color="green">Clean. Everything is committed.</Text>
      ) : (
        <>
          <Text color="yellow">{`${info.changed.length} uncommitted file${info.changed.length === 1 ? "" : "s"}`}</Text>
          {info.changed.slice(0, MAX_CHANGED_FILES).map((f) => (
            <Box key={f} paddingLeft={2}>
              <Text dimColor>{fit(f, Math.max(4, width - 2))}</Text>
            </Box>
          ))}
          {info.changed.length > MAX_CHANGED_FILES ? (
            <Text dimColor>{`  +${info.changed.length - MAX_CHANGED_FILES} more`}</Text>
          ) : null}
        </>
      )}

      {info.unmerged.length > 0 ? (
        <>
          <Text color="yellow">{`${info.unmerged.length} commit${info.unmerged.length === 1 ? "" : "s"} not merged into the base branch`}</Text>
          {info.unmerged.slice(0, MAX_UNMERGED).map((c) => (
            <Box key={c} paddingLeft={2}>
              <Text dimColor>{fit(c, Math.max(4, width - 2))}</Text>
            </Box>
          ))}
        </>
      ) : (
        <Text dimColor>Nothing waiting to merge.</Text>
      )}
    </Box>
  );
}

export default AgentDetail;
