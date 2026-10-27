/**
 * Hiring, as a form.
 *
 * Six fields, but only one of them is the product: the brief. A name is a
 * label and a budget is a number. The brief is the entire instruction an
 * agent will ever get. The difference between a good one and a vague one is
 * the difference between useful output and plausible noise. So the brief is
 * the field with the presets, the word count, and the warning, and the
 * others get out of the way.
 *
 * The warning under a thin brief is a warning and not a block. Someone who
 * knows exactly what they want from a nine-word brief should not have to
 * pad it to satisfy a form. The core's own ten-character floor is the only
 * hard gate, and it belongs to the core.
 *
 * Two of the agent's configuration fields are here and two are not. Autonomy
 * and the collaboration brief are decisions you can only make at hire time:
 * what this agent is permitted to do, and who it defers to. Both are one
 * keystroke or one sentence. The system-prompt override and the per-agent
 * guardrails are not. A guardrail is written after you have watched an agent
 * do something you did not want. An override is a page of text that a
 * one-line field would mangle. Those are `/guardrail` and `/prompt`, and a
 * hire form that asked for them would mostly collect blank answers.
 */

import { Box, Text, useInput } from "ink";
import { isTab, isReturn, isEscape } from "../keys.js";
import { useEffect, useState, type ReactNode } from "react";

import { billingFor } from "../../core/auth.js";
import { policyFor } from "../../core/autonomy.js";
import { ROLE_TEMPLATES } from "../../core/nextstep.js";
import { nextProvider, providerFor } from "../../core/providers.js";
import type { Readiness } from "../../core/setup.js";
import { validateName } from "../../core/roster.js";
import type { AutonomyLevel, Provider } from "../../core/types.js";
import { autonomyColor, fit, nextAutonomy, providerColor, wrap } from "../format.js";
import Modal, { Field } from "./Modal.js";
import TextField from "./TextField.js";

/** Below this a brief tends to under-specify the deliverable. Advisory only. */
const THIN_BRIEF_WORDS = 15;

const LABEL_WIDTH = 8;

/** Marker, label, and the gap before a value: where sub-lines start. */
const NOTE_INDENT = LABEL_WIDTH + 3;

/**
 * Matches the core's default. Not "the safest option". That would be
 * `observe`. An org whose every agent defaults to read-only would have
 * people cycling the field on every hire until they stopped reading it.
 * `execute` is the level that does useful work while still keeping a human
 * on the merge.
 */
const DEFAULT_AUTONOMY: AutonomyLevel = "execute";

const FIELDS = ["name", "role", "collab", "provider", "model", "budget", "autonomy", "isolated"] as const;

/**
 * Something the form can be filled from: a built-in role template, or a
 * seat from the suggested team. A template sets only the brief. A seat
 * sets everything, because its provider, model, level and cap were derived
 * from evidence and are as much the suggestion as the words are.
 */
export type HirePreset = {
  name: string;
  brief: string;
  collaboration?: string;
  provider?: Provider;
  model?: string;
  budgetUsd?: number;
  autonomy?: AutonomyLevel;
  isolated?: boolean;
  guardrails?: string[];
  /** Shown beside the preset's name in the hint. */
  tag?: string;
};

export const TEMPLATE_PRESETS: HirePreset[] = ROLE_TEMPLATES.map((t) => ({ name: t.name, brief: t.brief, isolated: t.suggestIsolated }));
type FormField = (typeof FIELDS)[number];

export type HireFormProps = {
  width: number;
  /** Names already in the org, so a collision is visible before submitting. */
  existingNames: string[];
  /** Per-provider readiness, read once by App. A provider that is not ready cannot be hired on. */
  readiness: Readiness[];
  /** Templates and suggested seats, cycled with ↑↓ on the role field. Defaults to the built-in templates. */
  presets?: HirePreset[];
  /** Open with this preset already applied, as enter on a suggested seat does. */
  initial?: HirePreset | null;
  onSubmit: (values: {
    name: string;
    role: string;
    provider: Provider;
    model: string;
    budgetUsd: number;
    isolated: boolean;
    autonomy: AutonomyLevel;
    collaboration: string;
    guardrails: string[];
  }) => void;
  onCancel: () => void;
};

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Digits and one decimal point, checked on the whole value not the key. */
function isBudgetText(s: string): boolean {
  return /^\d*\.?\d*$/.test(s);
}

export function HireForm({ width, existingNames, readiness, presets = TEMPLATE_PRESETS, initial = null, onSubmit, onCancel }: HireFormProps) {
  const [field, setField] = useState<FormField>(initial ? "role" : "name");
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.brief ?? "");
  const [budget, setBudget] = useState(String(initial?.budgetUsd ?? 5));
  const [isolated, setIsolated] = useState(initial?.isolated ?? false);
  const [collaboration, setCollaboration] = useState(initial?.collaboration ?? "");
  const [guardrails, setGuardrails] = useState<string[]>(initial?.guardrails ?? []);
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(initial?.autonomy ?? DEFAULT_AUTONOMY);
  const [provider, setProvider] = useState<Provider>(initial?.provider ?? "claude");
  const [model, setModel] = useState(initial?.model ?? providerFor(initial?.provider ?? "claude").defaultModel());
  // Whether the model box holds a typed value. Cycling the provider replaces
  // a default with the new provider's default and leaves a typed one alone.
  const [modelTouched, setModelTouched] = useState(Boolean(initial?.model));

  // Whether the brief in the box is the user's own words. Once it is, nothing
  // typed into the name field is allowed to overwrite it.
  const [roleTouched, setRoleTouched] = useState(Boolean(initial));
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(initial?.name ?? null);
  const [presetIndex, setPresetIndex] = useState(initial ? Math.max(0, presets.findIndex((p) => p.name === initial.name)) : -1);

  /** Fill every field a preset carries. A template carries only the brief. */
  const applyPreset = (p: HirePreset) => {
    setRole(p.brief);
    setPrefilledFrom(p.name);
    if (p.collaboration !== undefined) setCollaboration(p.collaboration);
    if (p.guardrails !== undefined) setGuardrails(p.guardrails);
    if (p.autonomy !== undefined) setAutonomy(p.autonomy);
    if (p.isolated !== undefined) setIsolated(p.isolated);
    if (p.budgetUsd !== undefined) setBudget(String(p.budgetUsd));
    if (p.provider !== undefined) setProvider(p.provider);
    if (p.model !== undefined) {
      setModel(p.model);
      setModelTouched(true);
    } else if (p.provider !== undefined && !modelTouched) {
      setModel(providerFor(p.provider).defaultModel());
    }
  };

  // Typing a preset's name is the most likely way someone arrives at it, so
  // the form follows the name until the brief is edited.
  useEffect(() => {
    if (roleTouched) return;
    const preset = presets.find((p) => p.name === name);
    if (preset) {
      applyPreset(preset);
    } else if (prefilledFrom) {
      setRole("");
      setPrefilledFrom(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, roleTouched, prefilledFrom]);

  const move = (delta: number) => {
    const i = FIELDS.indexOf(field);
    setField(FIELDS[(i + delta + FIELDS.length) % FIELDS.length]);
  };

  const pickPreset = (delta: number) => {
    if (presets.length === 0) return;
    const next = (presetIndex + delta + presets.length) % presets.length;
    setPresetIndex(next);
    const preset = presets[next];
    applyPreset(preset);
    if (!name.trim() || presets.some((p) => p.name === name)) setName(preset.name);
    // An explicit pick outranks the name field.
    setRoleTouched(true);
  };

  const cycleProvider = () => {
    const next = nextProvider(provider);
    setProvider(next);
    if (!modelTouched) setModel(providerFor(next).defaultModel());
  };

  const cycleModel = (delta: number) => {
    const list = providerFor(provider).models();
    const i = list.indexOf(model);
    const next = list[(Math.max(i, 0) + delta + list.length) % list.length];
    setModel(i < 0 && delta < 0 ? list[list.length - 1] : next);
    setModelTouched(false);
  };

  const providerReady = readiness.find((r) => r.provider === provider)?.ready ?? true;

  const submit = () => {
    // Hiring on a provider that cannot run is refused here rather than at the
    // first delegation: the agent would sit in the roster looking hireable
    // and fail on every task. The form stays open with the field focused.
    if (!providerReady) {
      setField("provider");
      return;
    }
    const parsed = Number(budget);
    onSubmit({
      name: name.trim(),
      role: role.trim(),
      provider,
      model: model.trim() || providerFor(provider).defaultModel(),
      budgetUsd: Number.isFinite(parsed) ? parsed : 5,
      isolated,
      autonomy,
      collaboration: collaboration.trim(),
      guardrails,
    });
  };

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (isTab(input, key)) {
      move(key.shift ? -1 : 1);
      return;
    }
    if (isReturn(input, key)) {
      submit();
      return;
    }
    if (field === "isolated" && (input === " " || key.leftArrow || key.rightArrow)) {
      setIsolated((v) => !v);
      return;
    }
    // Same gesture as `isolated`, one field up: space or either arrow. Four
    // states rather than two, so it cycles instead of toggling.
    if (field === "autonomy" && (input === " " || key.leftArrow || key.rightArrow)) {
      setAutonomy((v) => nextAutonomy(v));
      return;
    }
    if (field === "provider" && (input === " " || key.leftArrow || key.rightArrow)) {
      cycleProvider();
      return;
    }
    if (field === "model" && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      cycleModel(key.upArrow || key.leftArrow ? -1 : 1);
      return;
    }
    if (field === "role" && (key.upArrow || key.downArrow)) {
      pickPreset(key.downArrow ? 1 : -1);
    }
  });

  const inner = Math.max(24, width - 4);
  const fieldWidth = Math.max(12, inner - LABEL_WIDTH - 4);
  // Sub-lines sit under the value column, so they get less room than the box.
  // Sizing them to `inner` is what makes ink wrap them into the margin.
  const noteWidth = Math.max(20, inner - NOTE_INDENT);

  const nameError =
    name.length === 0
      ? null
      : existingNames.includes(name)
        ? `"${name}" is already in the org. Fire it first, or pick another name.`
        : validateName(name);

  const words = wordCount(role);
  const chars = role.trim().length;

  const spec = providerFor(provider);
  const billing = billingFor(provider);
  const enforcement = spec.enforcementLabel(autonomy, []);

  return (
    <Modal
      title="Hire an agent"
      footer={providerReady ? "tab / shift-tab field · enter hire · esc cancel" : `tab / shift-tab field · enter blocked (${provider} not ready) · esc cancel`}
      width={width}
    >
      <Field label="name" labelWidth={LABEL_WIDTH} focused={field === "name"}>
        <TextField
          value={name}
          onChange={setName}
          placeholder="lowercase-with-hyphens"
          focused={field === "name"}
          width={fieldWidth}
        />
      </Field>
      {/* Live, not on submit: the rule is easier to satisfy while you are
          still typing the name than after the form has been rejected. */}
      <Note>
        {nameError ? (
          wrap(nameError, noteWidth, 2).map((line, i) => (
            <Text key={i} color="red">
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>
            {fit("Becomes the branch suffix, so keep it slug-safe.", noteWidth)}
          </Text>
        )}
      </Note>

      <Box marginTop={1} />
      <Field label="role" labelWidth={LABEL_WIDTH} focused={field === "role"}>
        <TextField
          value={role}
          onChange={(v) => {
            setRole(v);
            setRoleTouched(true);
            setPrefilledFrom(null);
          }}
          placeholder="what this agent is for, and what it must not do"
          focused={field === "role"}
          width={fieldWidth}
        />
      </Field>
      {/* The brief is the one field worth spending three lines of chrome on. */}
      <Note>
        <Text dimColor>{fit(`${words} words · ${chars} chars`, noteWidth)}</Text>
      </Note>
      {prefilledFrom ? (
        <Note>
          <Text dimColor>
            {fit(
              `pre-filled from "${prefilledFrom}". Edit or clear it${guardrails.length > 0 ? ` · ${guardrails.length} guardrail${guardrails.length === 1 ? "" : "s"} attached` : ""}`,
              noteWidth,
            )}
          </Text>
        </Note>
      ) : null}
      {chars > 0 && words < THIN_BRIEF_WORDS ? (
        <Note>
          {wrap(
            "Thin brief. Output tends to come back as thin as the brief that asked for it. Say what the deliverable is and what to leave alone.",
            noteWidth,
            2,
          ).map((line, i) => (
            <Text key={i} color="yellow">
              {line}
            </Text>
          ))}
        </Note>
      ) : null}
      <Note>
        <Text dimColor>
          {fit(
            `${field === "role" ? "↑↓" : "on the role field, ↑↓"} picks a preset: ${presets
              .map((t) => (t.tag ? `${t.name} (${t.tag})` : t.name))
              .join(" · ")}`,
            noteWidth,
          )}
        </Text>
      </Note>

      <Box marginTop={1} />
      <Field label="collab" labelWidth={LABEL_WIDTH} focused={field === "collab"}>
        <TextField
          value={collaboration}
          onChange={setCollaboration}
          placeholder="who it defers to, what it hands off, when to stop and ask"
          focused={field === "collab"}
          width={fieldWidth}
        />
      </Field>
      {/* `role` answers "what is your job". This answers "how do you fit".
          Optional, and empty is honest for a one-agent org. */}
      <Note>
        <Text dimColor>
          {fit("optional · how this agent fits with the rest of the org", noteWidth)}
        </Text>
      </Note>

      <Box marginTop={1} />
      <Field label="provider" labelWidth={LABEL_WIDTH} focused={field === "provider"}>
        <Text color={providerColor(provider)} bold={field === "provider"}>
          {provider.padEnd(7)}
        </Text>
        <Text dimColor>{field === "provider" ? "space cycles · " : ""}</Text>
        <Text dimColor>{spec.headless}</Text>
      </Field>
      {/* Which account the run draws on, said before the hire rather than on
          the invoice. A metered key is a warning, not a block. */}
      <Note>
        {!providerReady ? (
          wrap(
            `${provider} is not ready: ${readiness.find((r) => r.provider === provider)?.fix[0] ?? "install and sign in"}. Press esc, then S for setup.`,
            noteWidth,
            3,
          ).map((line, i) => (
            <Text key={i} color="red">
              {line}
            </Text>
          ))
        ) : billing.warning ? (
          wrap(billing.warning, noteWidth, 2).map((line, i) => (
            <Text key={i} color="yellow">
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>{fit(billing.summary, noteWidth)}</Text>
        )}
      </Note>

      <Box marginTop={1} />
      <Field label="model" labelWidth={LABEL_WIDTH} focused={field === "model"}>
        <TextField
          value={model}
          onChange={(v) => {
            setModel(v);
            setModelTouched(true);
          }}
          placeholder={spec.defaultModel()}
          focused={field === "model"}
          width={fieldWidth}
        />
      </Field>
      <Note>
        <Text dimColor>
          {fit(
            `${field === "model" ? "↑↓" : "on the model field, ↑↓"} cycles: ${spec.models().join(" · ")} · or type any ${spec.label} model id`,
            noteWidth,
          )}
        </Text>
      </Note>

      <Box marginTop={1} />
      <Field label="budget" labelWidth={LABEL_WIDTH} focused={field === "budget"}>
        <TextField
          value={budget}
          onChange={(v) => {
            if (isBudgetText(v)) setBudget(v);
          }}
          placeholder="5"
          focused={field === "budget"}
          width={12}
          filter={(ch) => /[0-9.]/.test(ch)}
        />
        <Text dimColor>{"  USD hard cap · 0 means uncapped"}</Text>
      </Field>

      <Box marginTop={1} />
      <Field label="autonomy" labelWidth={LABEL_WIDTH} focused={field === "autonomy"}>
        <Text color={autonomyColor(autonomy)} bold={field === "autonomy"}>
          {autonomy.padEnd(11)}
        </Text>
        <Text dimColor>{field === "autonomy" ? "space cycles" : ""}</Text>
      </Field>
      {/* The level is a tool allowlist, so the note says what it permits
          rather than restating the word that is already on the line. */}
      <Note>
        {wrap(policyFor(autonomy).label, noteWidth, 2).map((line, i) => (
          <Text key={i} color={autonomyColor(autonomy)}>
            {line}
          </Text>
        ))}
        {/* The level is enforced by the child process, differently per
            provider, and the form says how rather than leaving it a word. */}
        <Text dimColor>{fit(`enforced on ${spec.label} as ${enforcement}`, noteWidth)}</Text>
      </Note>

      <Box marginTop={1} />
      <Field label="isolated" labelWidth={LABEL_WIDTH} focused={field === "isolated"}>
        <Text color={isolated ? "cyan" : undefined} bold={field === "isolated"}>
          {isolated ? "[x] yes" : "[ ] no "}
        </Text>
        <Text dimColor>{field === "isolated" ? "  space toggles" : ""}</Text>
      </Field>
      <Note>
        {wrap(
          `changes land on branch ceo/${name || "<name>"} instead of the working tree`,
          noteWidth,
          2,
        ).map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Note>
    </Modal>
  );
}

/** An indented sub-line under a field, aligned with the field's value column. */
function Note({ children }: { children: ReactNode }) {
  return (
    <Box paddingLeft={NOTE_INDENT} flexDirection="column">
      {children}
    </Box>
  );
}

export default HireForm;
