# The constellation

The constellation is the org drawn as a sky. The chief of staff is a black
hole at the centre. Every other agent is a star in orbit. A note between
two agents crosses the sky as a comet. The view reads at a glance: who is
working, who waits, and who is talking to whom.

<p align="center">
  <img src="sky.gif" alt="The constellation: a black hole with a swirling disk for the chief of staff; twelve agents on claude, codex and gemini born at the horizon, spiralling in to work and trading notes as comets" width="900">
</p>

## Opening the sky

| Where | Key |
| --- | --- |
| The dashboard | `O` opens the sky |
| The terminal | `ceo sky` opens the dashboard on the sky. `ceo constellation` does the same. |
| The live view | `O` switches to the sky. `L` in the sky switches back. |

The sky animates only while open. Nothing is written to the ledger.

## What each element means

| Element | Meaning |
| --- | --- |
| Black hole | The chief of staff. The name sits inside the horizon. |
| Accretion disk | Two spiral arms around the horizon. The arms turn faster as more agents work. The photon ring brightens while the chief replies. |
| Star | An agent. The colour is the provider: cyan for claude, green for codex, blue for gemini. |
| `✦` twinkling | The agent is working. The star spirals in toward the disk. |
| `◌` | The agent is waiting out a provider limit. The task is back in the queue. |
| `✧` | The run finished in the last two minutes. |
| `✕` | The run failed in the last five minutes. |
| `•` | The agent is idle. Idle stars drift on the outer rings. |
| Constellation line | Two agents traded notes. The line is brighter for a recent exchange. |
| Comet | A note in flight. The comet leaves the sender and arrives at the receiver over three seconds. The path bends around the hole. |
| Amber trail | A question. |
| Green trail | A reply. |
| Ripple | A note to everyone. The ripple spreads from the sender. |
| Pink point at the top | The operator, as sender or receiver of a note. |
| Birth at the horizon | A new agent appears at the horizon and drifts out to an orbit. |

A note already on the board when the view opens is drawn as a line. Only a
note that arrives while the sky is open flies as a comet.

## The header and the info line

The header names the workspace, the agent count and how many agents are
working. A count of agents waiting on a limit appears in amber. Each
provider that is waiting out a limit shows the time left. The right edge
counts agents per provider.

The line under the sky describes the selected star: provider, model, then
the task, the turn and the seconds elapsed. With no star selected, the
line shows the latest exchange.

## Keys

| Key | Does |
| --- | --- |
| `←` `→` | Select the next or the previous star, clockwise from the top. |
| `enter` | Open the selected agent's detail view. |
| `L` | Switch to the cards in the live view. |
| `C` | Open the chat with the chief of staff. |
| `esc` or `O` | Back to the dashboard. |

## How the sky scales

Rings are spaced to leave room for names. A sky with a few dozen agents
shows every name. A crowded sky drops the names and keeps the stars. The
selected star and every working star keep the name. Hundreds of agents
therefore fit in one terminal. A larger window holds more names.

A swarm is the usual cause of a crowd. See [swarms and limits](swarms.md).
The sky reads the same traces as the [live view](collaboration.md#the-live-view).
