## What

One paragraph: what changes for a person using `ceo`.

## Why

## Invariants

- [ ] No ledger entry is mutated. Corrections are appended.
- [ ] Every `.ceo/` write goes through a core function that takes the lock.
- [ ] Autonomy is still enforced by the child process, not by prompt wording. That means the allowlist on claude, the sandbox on codex and the mode on gemini.
- [ ] No path records $0 for a run that spent money. Estimates are marked.
- [ ] Provider-specific flags or output shapes live only in `src/core/providers.ts`.

## Verified

Say how, concretely. "Drove it under `tools/keydrive.py` at 120x40 and read the frame" is a verification. "Should work" is not. No real agent runs are needed for anything in this repo. If you needed one, say what it cost.

```
pnpm build && pnpm typecheck && pnpm test
```
