# Integrations

GitHub, Hugging Face, alerts and Reflex skills, on one screen. `I` on the
dashboard opens the screen. GitHub goes through the `gh` login. Hugging
Face reads the token that `hf auth login` saved, or `HF_TOKEN`. Slack and
webhook URLs live in `~/.ceo/alerts.json`. CEO stores no model-provider
credential.

<p align="center">
  <img src="integrations.gif" alt="The integrations screen; a test alert; an open issue handed to the chief of staff; a pull request opened for an agent's branch" width="900">
</p>

## GitHub

CEO works through the `gh` CLI. The account, the host and the permissions
are whatever `gh auth status` says.

```sh
brew install gh
ceo setup github        # runs gh auth login once
ceo github              # the account, the repo, the open issues
```

- **Issues as context.** `g` on the integrations screen, or in the docket,
  lists the open issues. `enter` gives an issue to an agent as context,
  with the issue's comments. `t` queues the issue as a task for the agent
  and gives the agent the issue too. `c` hands the issue to the chief of
  staff in the chat.
- **Pull requests.** `P` on the roster, or `ceo pr <agent>`, pushes the
  agent's branch and opens a pull request into the base branch. The body
  is the ledger's account of the branch: each run's task, provider, model
  and cost, and the total. A note of kind `pr` records the URL.
- **Issues and pull requests in the docket.** `#42`, `pr #12` and GitHub
  URLs all add to the docket.

## Hugging Face

Public models, datasets, Spaces and papers need no setup. A token adds
private repos. CEO reads the token the Hub's own tools save, or `HF_TOKEN`.

```sh
ceo hf acme/retry-coder          # a model card, as an agent reads the card
ceo hf datasets/acme/flaky-runs
ceo hf paper:2408.01234
pip install -U huggingface_hub && hf auth login    # only for private repos
```

In the docket, `hf:org/model`, `hf:datasets/org/name`, `hf:spaces/org/name`,
`paper:<arxiv id>` and huggingface.co URLs each add a card. A model card
carries the pipeline, the library, downloads, likes, tags and the README.
A paper carries the title, the authors and the abstract.
`CEO_HF_ENDPOINT` points at another Hub, or at a directory.

## Alerts

Seven events can raise an alert, on four channels.

| Event | When |
| --- | --- |
| `done` | A run finished. Off by default. |
| `failed` | A run failed |
| `budget` | A run was refused at the agent's budget |
| `denied` | An agent reached past the agent's level |
| `chief` | The chief of staff replied while the chat was closed |
| `queue` | The last queued task settled |
| `limit` | A provider hit a rate or usage limit. The task went back to the queue. |

| Channel | Setting |
| --- | --- |
| Terminal bell | `b` on the integrations screen, `ceo alerts bell on` |
| Desktop notification | `d`, `ceo alerts desktop on`. osascript on macOS, notify-send elsewhere |
| Slack | `s`, `ceo alerts slack <incoming-webhook-url>` |
| Any webhook | `w`, `ceo alerts webhook <url>`. A JSON POST with the event |

The digits `1` to `7` on the integrations screen turn events on and off.
`t`, or `ceo alerts test`, sends a test on every channel that is on and
reports which worked. The settings live in `~/.ceo/alerts.json`, one file
per person. The bell and the desktop are on by default.

## Reflex skills

The card shows how many skills are ready and how many workflows Reflex is
still waiting to have approved. `k` opens the catalogue. The docket gives
a skill to an agent. See [the docket](docket.md#skills).

## Everval

Everval grades work against a collection of scenarios. A check names a
collection file. `everval:evals/retry.json#flaky` grades the scenario
`flaky`. A collection with one scenario needs no name.

```sh
ceo task add coder "Fix the flaky retry test" --verify "everval:evals/retry.json#flaky"
ceo verify "everval:evals/retry.json#flaky"
```

CEO calls the `everval` binary, or the path in `CEO_EVERVAL_BIN`. Calls
keep data in `.ceo/everval`. The graded output is the attempt's changed
files by default. The experiment decides the verdict. Each result is a
`verify` event that holds the experiment id and the failing checks. An
experiment that cannot grade is an error, never a pass. See
[verification](verification.md).

## The Reflex loop

The loop runs in both directions.

CEO reads Reflex. The suggested team proposes seats from Reflex workflows.
The docket gives Reflex skills to agents. The router reads `reflex.db` as a
prior, at half the weight of one ledger observation. A ready skill that
shares words with a task title becomes a variant of the agent's arm.

Reflex reads CEO's runs and verdicts. Reflex is getting a CEO source
adapter. The adapter reads `.ceo/runs` and treats `verify` events as reward.
A new Reflex skill then becomes an arm that the router can try. The verdicts
of those attempts return as evidence. See [the router](router.md) and
[the suggested team](suggest.md).
