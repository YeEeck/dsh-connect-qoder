# Issue tracker: Local Markdown (.scratch/)

Issues and specs for this repo live as markdown files under `.scratch/`.

GitHub Issues 在这个 fork 上是**关闭**的（`gh issue list` 直接回 `has disabled issues`）。
不要往那里开单，也不要用 `gh issue create` 兜底——它同样会失败。

历史档案 `docs/issues/NN-*.md` 与索引 `docs/issues/README.md` 保持原样：那些是按日期归档的事故记录
（导航见 `AGENTS.md` 的「去哪查」）。**新问题不往那里加编号**，一律走本文件描述的 `.scratch/`。

## Conventions

- 一个工作单元一个目录：`.scratch/<effort-slug>/`
- 规格是 `.scratch/<effort-slug>/spec.md`
- 工单一张一个文件：`.scratch/<effort-slug>/issues/<NN>-<slug>.md`，编号从 `01` 起，
  **每个 effort 各自从 `01` 开始**；禁止把多张工单合并成一个文件
- 状态写在文件前部的 `Status:` 行，取值见 [`triage-labels.md`](triage-labels.md)；
  分类写在 `Category:` 行（`bug` / `enhancement`）
- 版式沿用本仓既有习惯：第一行 `# <标题>`，紧接一行优先级元信息，形如
  `**P1 · 规模 M · 依赖 03**`；优先级口径见 `docs/PLAN.md`
- 评论与讨论追加到文件底部 `## Comments` 之下
- **`.scratch/` 没有进 `.gitignore`**，写进去的文件会被提交；被忽略的是无点的 `scratch/`
  （一次性探针脚本的落地处，见 `.gitignore` 注释），两个目录别混

## When a skill says "publish to the issue tracker"

在 `.scratch/<effort-slug>/` 下新建文件（目录不存在就建）。

## When a skill says "fetch the relevant ticket"

读对应路径的文件。用户通常直接给路径；只给编号时在 `.scratch/*/issues/` 里按文件名前缀找，
命中多个 effort 就先列出来问清楚，别默认挑第一个。

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body.
  A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`);
  a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
