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

## Layouts

The same sky has six arrangements, plus `auto`. The bar under the header
shows every choice. The active one is lit. A switch eases every star from
the old arrangement to the new one. The info line names the layout for a
few seconds after a switch.

| Key | Layout | Arrangement |
| --- | --- | --- |
| `0` | auto | Picks a layout from the shape of the org. The chip reads `auto · <layout>`. |
| `1` | ◎ orbit | Working agents circle close to the disk. Idle agents drift on the outer rings. Faint rings mark the orbits. |
| `2` | ◑ providers | One wedge of the sky per provider, sized by head count. Each wedge carries its name and count at the rim. |
| `3` | ⁂ teams | Each swarm and each team gathers into a cluster. Working members sit at the heart. A label names the team, the size and how many work. |
| `4` | ✳ web | Agents that trade notes pull together. Pairs that trade more pull harder. Agents linked to the chief fall close to the hole. Loners drift to the rim. |
| `5` | ◈ spend | The heaviest spenders fall closest to the hole. Two gold rings mark equal spend. |
| `6` | ❋ spiral | The org's history on two arms. The first hires sit innermost. |

`[` and `]` step through the choices. The choice is remembered in
`~/.ceo/sky.json` for the next session.

Auto reads four signals, in order:

1. Six agents or more with a team of four or more: teams. A swarm reads best as clusters.
2. Three notes or more in the last minute: web.
3. Nine agents or more on two providers or more: providers.
4. Anything else: orbit.

Auto changes its mind only after a new pick holds for a few seconds. The sky
never flickers between two layouts.

`ceo sky --layout web` opens on one layout. `CEO_SKY_LAYOUT` does the same
from the environment.

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
| `0` to `6` | Choose a layout: auto, orbit, providers, teams, web, spend, spiral. |
| `[` `]` | Step to the previous or the next layout. |
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
