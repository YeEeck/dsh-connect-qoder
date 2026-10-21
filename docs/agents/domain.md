# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront.
The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

**本仓现状**：`CONTEXT.md`、`CONTEXT-MAP.md`、`docs/adr/` 都还没有。已有的决策记录在
`docs/history/`（例：`0.5.0-abi-cutover.md`）与 `docs/issues/NN-*.md`——它们是按日期归档的审计快照，
读它们是为了弄清「为什么长成这样」，不是当作现行规范。ADR 一旦建立，可以推翻的裁定写进 `docs/adr/NNNN-*.md`。

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

Layout is **single-context**. 多上下文需要 `pnpm-workspace.yaml`、`package.json` 的 `workspaces` 字段，
或成形的 `packages/*/src/`——三样都没有。`src/host/` 与 `src/client/` 是同一个插件的两半（Host 进程与
客户端 bundle），不是两个上下文；本仓的隔离轴是 **region（qoder / qoder-cn）**，不是包边界。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

Until `CONTEXT.md` exists, the de-facto glossary is the wording already pinned in `AGENTS.md`（「三条事实」、
双 region、凭据来源、静默失败）. Reuse it rather than inventing new terms.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
