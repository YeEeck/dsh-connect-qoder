# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## How the strings are used here

五个字符串与角色名一一相同，所以不需要翻译。本仓的问题库是本地 Markdown（见
[`issue-tracker.md`](issue-tracker.md)），没有标签系统，这些字符串因此写成**工单文件里的行**：

- `Status:` 行取五个状态角色之一，任何时刻**恰好一个**
- `Category:` 行取两个分类角色之一（`bug` / `enhancement`），任何时刻**恰好一个**

状态流转与角色含义由 `/triage` 技能定义，本文件只负责字符串映射，不重复那套状态机。
