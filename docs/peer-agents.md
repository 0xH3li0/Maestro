---
title: Peer Agents
description: Authorize an agent to consult or delegate to other agents on its own, without you typing an @mention. Set it per agent, per group, or per worktree family.
icon: network-wired
---

A peer is another agent that one agent may reach **without being told to in a message**. Normally an agent only talks to another agent when you type `@name`. Peers remove that step: you decide once who an agent may reach and how, and the agent decides for itself, mid-task, whether to reach out.

The list of peers is a **roster**. It is a permission list, the same way [Additional Directories](./general-usage) are: an agent reaches exactly the agents on its roster, with exactly the access listed, and nobody else.

## Why It Exists

A backend agent that needs to know what the API consumer expects can ask the frontend agent itself. A release agent can hand a changelog to the docs agent and carry on. Without a roster, every one of those hand-offs waits for you to notice and type the mention.

A roster keeps this safe because it is explicit. An agent that is not on the table is out of bounds, and the agent is told so in its own system prompt.

## The R and W Squares

Each peer carries two independent squares. They are two different mechanisms, not two strengths of one.

| Square           | Authorizes                 | The agent runs                                                                         | What happens                                                                                                                                     |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **R** (Consult)  | Asking the peer a question | `maestro-cli ask <agent-id> "<question>"`                                              | The answer comes back to the asking agent. The peer runs in a hidden background tab, so the conversation you have open with it is never touched. |
| **W** (Delegate) | Handing the peer work      | `maestro-cli dispatch <agent-id> "<task>" --new-tab --notify-on-complete <its-own-id>` | The task lands in a new tab of the peer, and the delegating agent gets a turn of its own when the peer finishes.                                 |

The two squares combine into four labels, which are the ones the agent reads:

| R   | W   | Label                                                                      |
| --- | --- | -------------------------------------------------------------------------- |
| lit | lit | **Consult + Delegate**                                                     |
| lit | off | **Consult only**                                                           |
| off | lit | **Delegate only**                                                          |
| off | off | **No access** (an exclusion, see [Precedence](#precedence-and-exclusions)) |

A consult runs **as the peer**. It takes the peer's own model, Run on target, and gateway, so the answer is what the peer would have said. A hand-off from an agent is marked in that agent's transcript so you can see who reached whom.

## Setting Peers Up

Open **Edit Agent** (right-click an agent in the Left Bar, or `Cmd+K` then "Edit Agent") and go to the **Peers** tab. The same tab is in the New Agent dialog.

- **Add Peer** adds an explicit row. Pick the agent, light R and/or W, and optionally write a note.
- **Peers in my group** is one checkbox with its own R and W squares. It covers every other agent in the same group.
- **Worktree family** is the same idea for worktrees: the worktree parent, the sibling worktrees, and this agent's own worktree children.

The **note** on an explicit row is the hint the agent reads for when to reach that peer ("owns the billing schema, ask before changing a migration"). It is guidance, not a change to the access rule. Write notes the way you would brief a new teammate.

### Groups and worktrees are resolved live

The group and worktree checkboxes do not copy a list of agents. They store a grant, and Maestro works out who it covers **each time the agent starts a turn**. So:

- Drag an agent into the group and every agent with the group grant can reach it on its next turn.
- Drag it out, rename it, or delete it, and the roster reshapes with no further configuration.
- A group grant covers the agent's own group only. A group nested inside another is a separate team, and neither the parent group nor a child group is reached.
- An agent that is in no group has nobody for the group grant to cover. The checkbox says so.

When the group grant and the worktree grant both cover one peer, the peer gets the union of the two, so either one granting a square grants it.

## Precedence and Exclusions

Three sources feed a roster. They are applied in this order:

1. The **group grant** adds every other agent in the agent's group.
2. The **worktree grant** adds the worktree family, merged with the group grant by union.
3. An **explicit row** then **replaces** whatever the grants gave that peer. It does not add to them.

Because a row replaces rather than adds, one row can both raise and lower access:

- A group grant of **R** plus a row of **R + W** for one agent gives that agent full access and leaves the others consult only.
- A row with **neither square lit** is an **exclusion**. The group grant covers everyone else, and that one agent is left out. The Peers tab flags such a row so it is never mistaken for an empty one.

Deleting a row is different from lighting no squares. Deleting restores whatever the group or worktree grant says about that agent. An exclusion keeps the agent out.

An agent is never its own peer, and a row that points at an agent that no longer exists resolves to nobody.

## What the Agent Sees

The roster is rendered into the agent's system prompt as a `## Peer Agents` section:

```markdown
## Peer Agents

| Agent    | Agent ID    | Access             | Notes                  |
| -------- | ----------- | ------------------ | ---------------------- |
| Frontend | `a1b2c3...` | Consult + Delegate | Owns the checkout flow |
| Docs     | `d4e5f6...` | Delegate only      |                        |
```

Below the table the prompt teaches only the commands the roster allows, so an agent whose peers are all consult only is never shown the delegate command. It also tells the agent to decide for itself, from the notes and what it knows of each peer's scope, whether a peer is the right one to reach, and to tell you which peer it reached and why.

The access column is a hard rule, like a directory permission. Reaching an agent that is not on the table, or going beyond the access listed, is out of bounds.

Because the prompt is built when a turn starts, a change you make applies from the **next turn**. A turn already running keeps the roster it started with.

## Group Chats and Moderators Have No Peers

A [group chat](./group-chat) and its moderator have no peer roster, and the moderator's settings have no Peers tab. A group chat is already a roster: the moderator routes to the participants you mention. Peers are for the agents you work with one on one.

## The Consultation Budget

A group grant on a five-agent group makes a fully connected graph: A asks B, B asks C, C asks A. Each hop is a full agent turn, so the whole thing needs a bound.

The **consultation budget** is one number: the most consults and delegations that may be spent while working on **one of your messages**. It counts the whole chain. An agent that consults a peer who consults another peer spends two. Both consults and delegations draw on the same budget.

| Value        | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `25`         | The default. Generous for a real collaboration, fatal to a runaway. |
| `0`          | Peer consults and delegations are switched off entirely.            |
| `1` to `500` | A tighter or looser bound. There is no unlimited.                   |

Change it in **Settings > General > Consultation Budget**, or from the CLI:

```bash
maestro-cli settings set maxConsultationsPerTurn 10
```

The agent is told how much is left as each turn starts, so it can ration its consults instead of finding the ceiling by hitting it. When the budget is spent, the next `ask` or `dispatch` is **refused by name**, with the count and the setting that controls it, so the agent knows the peer was never reached and does not mistake a refusal for an empty answer.

## From the CLI

Everything in the Peers tab has a `maestro-cli` verb, so a roster can be scripted across a fleet. Agents may be given by id, a unique id prefix, or display name.

```bash
# One explicit row: r (consult), w (delegate), rw, or none (an exclusion)
maestro-cli update-agent Backend --peer Frontend:rw --peer Docs:w

# The hint the agent reads for when to reach a peer
maestro-cli update-agent Backend --peer-note "Frontend:owns the checkout flow"

# Delete a row. This is not the same as :none
maestro-cli update-agent Backend --remove-peer Docs

# The two derived grants: r, w, rw, or off
maestro-cli update-agent Backend --group-peers r --worktree-peers rw
```

| Flag                               | Does                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `--peer <agent>:<r\|w\|rw\|none>`  | Sets one explicit row. Repeatable.                                                     |
| `--peer-note <agent>:<text>`       | Sets the note on a row. Repeatable. Needs a row, and empty text clears it.             |
| `--remove-peer <agent>`            | Deletes a row, so the group and worktree grants apply to that agent again. Repeatable. |
| `--group-peers <r\|w\|rw\|off>`    | Sets the group grant. `off` clears it.                                                 |
| `--worktree-peers <r\|w\|rw\|off>` | Sets the worktree grant. `off` clears it.                                              |

These flags are a **patch**: naming one peer leaves the other rows alone. The same flags work on `update-group-settings`, so a [group's defaults](./features#groups) can carry a roster that new agents in the group start with.

To answer "who can this agent reach?" without opening a modal, read it back:

```bash
maestro-cli show agent Backend
maestro-cli show agent Backend --json
```

The output lists the configured rows (with their notes), the two grants and whether each is on, and then the **resolved roster**, with each entry labeled `explicit`, `group`, or `worktree` for the source that produced it. The configured rows and the resolved roster are different lists on purpose: an exclusion removes an agent the group grant would have added, and a row for a deleted agent adds nobody.

To read every agent's roster at once, as one graph of who reaches whom:

```bash
maestro-cli delegation graph
maestro-cli delegation graph --group <group-id>
```

## Related

- [Cross-Agent Mentions](./cross-agent-mentions) - the consult you type yourself, and the `maestro-cli ask` verb agents use
- [Agent Collaboration](./agent-collaboration) - how mentions, group chats, and peers fit together
- [Group Chat](./group-chat) - a moderator that routes between agents on your behalf
- [Git Worktrees](./git-worktrees) - the worktree family a worktree grant covers
- [CLI Reference](./cli-reference) - the full flag list for `update-agent` and `show agent`
