# kvmem-claude

kvspace 记忆层的 Claude Code 适配器。本仓是四家适配器（Claude Code / Codex /
Pi / DSH）的**参考实现**——下面的格式映射在此定死，其余三家照此对齐。

总纲：[array2d/kvmem-claude#1](https://github.com/array2d/kvmem-claude/issues/1)。
方案全文：array2d 工作区根 `KVSPACE-AGENT-MEMORY.md`。

## 记忆的 key 空间

```
/mem/<scope>/<kind>/<slug>/
    title     MEMORY.md 行的 `[标题]`
    desc      MEMORY.md 行的 `— ` 之后部分
    body      正文
    meta/     type src created updated uses description order name node_type project originSessionId
```

结构走路径而不是塞进单个值：可前缀查询、可单字段更新、可只读 `title`+`desc`
生成索引而不取 `body`。`scope` 是隔离边界，所以进路径不进字段。`kind` ∈
`user | feedback | project | reference`。

值一律 `[n]char/utf8`，只有 `meta/uses` 是 `int64`。

## 格式映射（定死）

| Claude Code | kvspace |
|---|---|
| 项目目录 slug | `<scope>` |
| `<slug>.md` 文件名 | `<slug>` |
| frontmatter `name` | `meta/name` |
| frontmatter `description` | `meta/description` |
| frontmatter `metadata.type` | `<kind>` **且** `meta/type` |
| frontmatter `metadata.<key>` | `meta/<key>`（标量原文照存） |
| frontmatter `metadata.modified` | `meta/updated` |
| frontmatter 之后的正文 | `body` |
| `MEMORY.md` 的 `- [标题](<slug>.md) — 摘要` 之 `[标题]` | `title` |
| `MEMORY.md` 之 `摘要` | `desc` |
| `MEMORY.md` 行号 | `meta/order` |
| — | `meta/src` = `claude` |
| — | `meta/uses`（int64，`kvmem use` 累加） |

`<scope>` 就是 Claude Code 自己的项目 slug：项目绝对路径里的 `/` 与 `.` 一律
换成 `-`（`/home/u/github.com/x` → `-home-u-github-com-x`）。四家适配器对同一
项目必须推出同一个 scope 串，否则记忆们碰不到一起。

映射遵守四条：

- **`MEMORY.md` 是投影，不是真相源**。`kvmem ls` 打印的就是它的内容，
  `import` / `export` / `sync` 一律从 kvspace 重建它。所以漏在索引外的记忆文件
  会在重建中被捞回来，而不是永远不可见。
- **`title` / `desc` 没有本地载体**，只活在 `MEMORY.md` 里，真相在 kvspace。
  因此它们不参与变更比对——否则删一次 `MEMORY.md` 就会把所有 `title` 推回 slug。
- **身份是文件名，不是 `frontmatter.name`**。本工作区 113 条记忆里已经有 2 条
  两者不一致；`name` 原样存进 `meta/name`，不当 key 用。
- **缺就是缺**。源文件没有的字段，不编造时间戳、标题或摘要。

## 两个口子

`kvmem` CLI：

```
kvmem put <scope>/<kind>/<slug> [--title T] [--desc D] [--body-file F|-] [--meta k=v]…
kvmem get <scope>/<kind>/<slug> [--json]
kvmem ls <scope>[/<kind>] [--json]        # 输出与 MEMORY.md 同形
kvmem search <scope>[/<kind>] <关键词>
kvmem use <scope>/<kind>/<slug>
kvmem rm <scope>/<kind>/<slug>

kvmem import [--dry-run] [--prefer local]     # 本地 .md → kvspace
kvmem export [--dry-run] [--prefer remote]    # kvspace → 本地 .md + MEMORY.md
kvmem sync   [--dry-run] [--prefer local|remote]
kvmem status
kvmem mcp                                     # MCP stdio server
```

公共参数：`--scope S`、`--project P`（默认 `cwd`，slug 由它推导）、
`--kvspace DSN`（默认 `$KVSPACE`，再默认 `redis://127.0.0.1:6379`）。

MCP server（`kvmem mcp`）把五个记忆动作暴露为 `mem_ls` / `mem_get` /
`mem_search` / `mem_put` / `mem_use`。仓内附了一份项目级 `.mcp.json`。

## 同步规则

变更判定用**内容哈希**，不用时间戳：`git checkout` / `touch` 只动 mtime，比时间
戳会把没变的记忆判成冲突。真要人工裁决时，报错信息里带上两侧的 `meta/updated`
与 `meta/src`。

```
只有一侧变更            → 该侧覆盖另一侧
两侧都变更、无基线      → 冲突：非零退出，列出两侧 updated/src
一侧删除、另一侧未变    → 传播删除
一侧删除、另一侧变更    → 冲突
```

冲突必须用 `--prefer local|remote` 显式裁决，绝不静默覆盖。`import` 不碰本地
任何文件（零本地风险），`export` 不碰 kvspace。

同步状态放在 `<CLAUDE_CONFIG_DIR>/projects/<scope>/.kvmem/state.json`——在
`memory/` 之外，Claude Code 期望的记忆目录布局原样不动。

## 降级

kvspace 不可用时适配器不罢工：

- 读（`ls` / `get` / `search`）降级读本地 `.md`，并在 stderr 声明（MCP 返回文本
  前缀 `[降级…]`）；
- 写（`put` / `use`）追加进
  `<CLAUDE_CONFIG_DIR>/.kvmem/pending.jsonl`，重连后回放；
- 该 scope 没有本地记忆目录就无处可降——直接报错，不返回空结果。

## 依赖

- Node ≥ 23（直接跑 `.ts`，无构建步骤）
- loader 路径上有 `libkvspace.so.1`（dispatch 前端；后端按 DSN 从
  `/usr/lib/kvspace` 装载：`shm://` → kvspace-c，`redis://` / `fs://` →
  kvspace-durable）
- 适配器只与前端对话，绝不直链后端。
- 一条必须知道的 ABI 缺口：durable 后端上，短命进程的最后一笔写要等
  `kvspaceClose` 才落盘（array2d/kvspace#23）。本适配器开的每个 store 都由进程级
  退出钩子 close（`src/store.ts`），e2e 的每条断言都跨进程，所以这里一旦回归就会挂测试。

```
npm install
node src/cli.ts --help
npm test          # 12 项验收，自包含（临时 CLAUDE_CONFIG_DIR）
```

`test/e2e.ts` 跑在真实后端上，但只用临时 scope，不碰真实记忆与真实 scope。

## 本工作区 113 条记忆上的实测

- `import` 把 112 条记忆 / 113 个文件（第 113 个是 `MEMORY.md`）导入 kvspace，
  本地文件逐字节未动。
- `kvmem ls` 逐行重现 `MEMORY.md`，并补回索引漏掉的那一条。
- 反向 `export` 逐字节重现 **113 个 `.md` 中的 109 个**。4 个例外是 3 处
  `metadata:` 与 `metadata: ` 的尾空格差异、1 处 frontmatter 键序差异，语义等价。
  键序是规范化的：`name`、`description`、
  `metadata.{node_type, type, project, originSessionId, created, modified}`。
