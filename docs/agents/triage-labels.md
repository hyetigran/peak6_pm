# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo’s issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role—for example, “apply the AFK-ready triage label”—use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Current limitation: bot cannot manage labels

The `glab` session authenticates as a project bot that can create and edit issues but gets 403 on label creation and issue links. Until a maintainer creates the five labels in the GitLab UI (or raises the bot's role), the triage role lives as the first line of each issue description: `**Triage:** \`ready-for-agent\``. Blocking edges live in each issue's "Blocked by" section; native blocking links are Premium-only on this instance regardless.
