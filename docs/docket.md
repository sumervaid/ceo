# The docket

The docket holds the context the operator gives agents, and records which
agent holds which piece. An item is a file or folder in the repository, a
GitHub issue or pull request, a Hugging Face model, dataset, Space or
paper, a web page, a skill, or a typed note. Each run starts with the items
the run's agent holds, in the agent's own prompt.

<p align="center">
  <img src="docket.gif" alt="The docket: context down the side, agents across the top in provider colours; an issue, a file, a model card, a paper, skills and a note, each given to chosen agents" width="900">
</p>

## Opening the docket

`D` on the dashboard opens the docket. `ceo docket` does the same from the
terminal. The chief of staff reads and changes the docket too, so "give the
reviewer issue 42 and the backoff paper" works in the chat.

## The grid

Context runs down the side, grouped as skills, files, GitHub, Hugging Face,
web and notes, each item with the item's size in tokens. Agents run across the
top, each name in the colour of the agent's provider. A filled dot is an
item the agent holds.

| Key | Does |
| --- | --- |
| `↑` `↓` | Pick an item |
| `←` `→` | Pick an agent |
| `space` | Give the item to the agent, or take the item back |
| `a` `A` | Give the item to every agent, or to none |
| `n` | Add an item, given to the agent under the cursor |
| `s` | Add a skill from the catalogue |
| `g` | Add an open GitHub issue |
| `r` | Fetch the item again |
| `x` | Remove the item from the docket |
| `p` | Show or hide the preview |
| `esc` | Back to the dashboard |

The row under the grid totals what each agent will read, against the limit.
The preview shows the selected item: the kind, the source, the size, who
holds the item, and the first lines.

## Adding an item

`n` opens one input line. The line reads the input and names the kind
before enter adds the item:

| Input | Reads as |
| --- | --- |
| `src/retry.ts` | a file in the repo |
| `src` | a folder: the folder's text files, up to 60 |
| `#42`, or an issue URL | a GitHub issue with the comments |
| `pr #12`, or a pull request URL | a pull request with the diff |
| `hf:org/model` | a Hugging Face model card |
| `hf:datasets/org/name`, `hf:spaces/org/name` | a dataset or a Space |
| `paper:2401.12345`, or a huggingface.co/papers URL | a paper: title, authors, abstract |
| `https://…` | a web page, stripped to text |
| `skill:name` | a skill from the catalogue |
| anything else | a note |

## When content is read

Files and folders are read when a run starts. An agent with a worktree
reads the files on the agent's own branch. Everything fetched from elsewhere
is snapshotted into `.ceo/context/<id>.md` when the item is added. A run therefore
reads what the operator saw. `r` fetches the item again and replaces the
snapshot.

## Limits

An item is cut at 24,000 characters, about 6,000 tokens. An agent's whole
docket is cut at 96,000 characters. The prompt says when something was cut.
`CEO_CONTEXT_ITEM_MAX` and `CEO_CONTEXT_MAX` change the figures.

## Skills

A skill is a procedure: when to use the skill, the workflow, constraints
and how to know the work is done. The catalogue reads every SKILL.md from five places:

| Source | Folder |
| --- | --- |
| Reflex | `~/.reflex/skills/`, the skills Reflex wrote from workflows a person repeats |
| this repo | `.claude/skills/` |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Cursor | `~/.cursor/skills/` |

A workflow Reflex found but nobody approved yet shows as waiting, with
Reflex's confidence. Picking one runs `reflex approve <name> --yes`, which
writes the SKILL.md, and the skill joins the docket like any other.

A skill in an agent's docket reaches the prompt in the skills section,
in full, on every provider. The scout gets the mapping skill. The fixer
gets the flaky-test skill. A skill a CLI loads from the CLI's own folder still
loads for every run of that CLI. The docket is how a skill reaches one
agent and not another.

## In the ledger

| Event | Written when |
| --- | --- |
| `context_add` | An item is added: kind, title, source, snapshot, size, and who added the item |
| `context_update` | An item is fetched again |
| `context_remove` | An item leaves the docket |
| `context_assign` | An agent is given an item |
| `context_unassign` | An item is taken back |

Each run's `delegate_start` lists the items the run was given. An audit can
open the same snapshots later.
