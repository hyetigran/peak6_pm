# Domain Docs

How the engineering skills should consume this repo’s domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists—it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**—read ADRs that touch the area you’re about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files do not exist, **proceed silently**. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

Single-context repo:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary’s vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the required concept is not in the glossary, either the language does not belong to the project or there is a genuine gap to note for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly instead of silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders)—but worth reopening because…_
