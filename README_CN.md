# kvmem-claude

kvspace 记忆层的 Claude Code 适配器。本仓是四家适配器（Claude Code / Codex /
Pi / DSH）的**参考实现**——下面的 key 空间与格式映射在此定死，其余三家照此对齐。

总纲：[array2d/kvmem-claude#1](https://github.com/array2d/kvmem-claude/issues/1)。
方案全文：array2d 工作区根 `KVSPACE-AGENT-MEMORY.md`。

**kvspace 是唯一存储。** `~/.claude/projects/<scope>/memory/` 只是它的投影：
派生物、可丢弃、随时可重建。既然没有第二份要调和，也就没有同步器、没有状态文件、
没有冲突裁决。

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

`<slug>` 同时是 kvspace 路径段与本地文件名（`<slug>.md`）。只禁两个符号：
`/`（路径分隔符）与 `·`（kvspace 成员符）。其余一律放行——中文、大写、点、空格、
`)`，甚至 `..`。

值一律 `[n]char/utf8`，只有 `meta/uses` 是 `int64`。

这棵树是 Claude Code 那棵文件树的逐条翻译，展开见下文
[Claude 的 memory 与 kvspace 的 keytree：逐条对应](#claude-的-memory-与-kvspace-的-keytree逐条对应)。

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

- **kvspace 是唯一存储。** `memory/*.md` 与 `MEMORY.md` 都是 `kvmem render`
  写出的投影，不是另一份真相。手改它们只改了投影，下一次 `render` 就还原成
  kvspace 的版本。
- **`MEMORY.md` 是索引，不是真相源。** `kvmem ls` 打印的就是它的内容，
  `render` 从 kvspace 重建它。所以漏在索引外的记忆会被重建捞回来；不是索引行的
  行（`# Memory Index` 这类标题、说明）一律跳过，不再致命。
- **身份是文件名，不是 `frontmatter.name`。** 本工作区 113 条记忆里已经有 2 条
  两者不一致；`name` 原样存进 `meta/name`，不当 key 用。
- **缺就是缺。** 源文件没有的字段，不编造时间戳、标题或摘要。

## Claude 的 memory 与 kvspace 的 keytree：逐条对应

Claude Code 那边是一棵**文件树**，kvspace 这边是一棵 **keytree**。同一个"记忆"在
两边形状不同，下面逐条说清谁对应谁。

### Claude Code 侧：文件树

```text
~/.claude/projects/<scope>/memory/
├── MEMORY.md            索引：一行一条记忆
└── <slug>.md            一条记忆 = 一个文件
    ├── frontmatter
    │   ├── name
    │   ├── description
    │   └── metadata
    │       ├── type        user | feedback | project | reference
    │       ├── node_type
    │       ├── project
    │       ├── originSessionId
    │       ├── created
    │       └── modified
    └── body               正文
```

### kvspace 侧：keytree

```text
/mem/<scope>/<kind>/<slug>/
├── title                 索引行的 [标题]
├── desc                  索引行的 — 摘要
├── body                  正文
└── meta/
    ├── name
    ├── description
    ├── type              与 <kind> 一致
    ├── node_type
    ├── project
    ├── originSessionId
    ├── created
    ├── updated           ← frontmatter 的 metadata.modified
    ├── src               哪个 agent 写的（KV 侧新增）
    ├── order             在索引里的位置（KV 侧新增）
    └── uses              int64 引用计数（KV 侧新增）
```

### 逐条对应

1. **项目目录 → scope 前缀。** Claude 用 `projects/<scope>/memory/` 这个目录做隔离，
   kvspace 用 `/mem/<scope>/` 这个前缀做隔离。kvspace 的地址本身带前缀包含语义
   （`0` 包含 `0.0`），所以"取本项目全部记忆"就是一次前缀列举，不需要额外的索引。

2. **一个记忆文件 → 一个子树。** `<slug>.md` 在 kvspace 里是
   `<scope>/<kind>/<slug>/`。文件变成子树，文件里的每样东西都各自有了地址。

3. **frontmatter 标量 → `meta/` 子 key。** `metadata.project: x` 这条，在 Claude 里
   是文件内的一行，在 kvspace 里是 `<slug>/meta/project` 这个节点。字段从"躺在文件
   里的一行"变成"树上可寻址的节点"，因此可以只改这一个字段。

4. **`metadata.type` → `<kind>` 一层路径**（同时仍在 `meta/type` 留一份）。这是全表
   唯一一处"字段升格成层"。理由：kind 是稳定又高频的查询维度（"取本项目全部
   feedback"），提到路径上就退化成一次前缀列举。`kind` ∈
   `user | feedback | project | reference`，写入时校验它与 `meta/type` 一致。

5. **`metadata.modified` → `meta/updated`。** 只是改名：`modified` 是 Claude 序列化
   器的叫法，KV 侧统一叫 `updated`。

6. **文件名（不是 `frontmatter.name`）→ `<slug>` 路径段。** 身份是文件名；`name`
   只是数据，原样存进 `meta/name`。本工作区 113 条里已经有 2 条两者不一致。

7. **`MEMORY.md` 的一行 → 三个节点的组合。** `- [标题](<slug>.md) — 摘要` 拆开：
   `[标题]` → `title`，`— 摘要` → `desc`，行号 → `meta/order`。所以索引不是数据，只是
   这三个字段的一个视图。

8. **正文 → `body`。** 一一对应，逐字保真。

9. **Claude 没有的三样：`src` / `order` / `uses`。** `src` 记哪个 agent 写的（四家
   汇聚后要知道出处）；`order` 记它在索引里的位置；`uses` 记被引用次数，供衰减排序。

10. **值的形态：纯文本文件 → XValue。** Claude 侧就是 `.md` 文本；kvspace 侧每个叶子
    都是一个 XValue（head 说 storetype/langtype，body 装内容），langtype 明文，agent
    能直接读。记忆树里除 `meta/uses` 用 `int64` 外，其余全是 `[n]char/utf8`——`uses`
    要就地 +1（8 字节 `writeInPlace`），其余都要明文可读。

11. **命名的合法性取交集。** Claude 的文件名不能含 `/`；kvspace 的路径段不能含 `/`
    （路径分隔符）与 `·`（list/map 的成员槽符号，见工作区 `SPEC-ALIGNMENT-TODO.md`
    二）。两边取交集，slug 就只禁这两个符号，其余一律放行：中文、大写、点、空格、
    `)`，甚至 `..`。

12. **`MEMORY.md` 在 Claude 侧既是人读入口也是程序入口，在 kvspace 侧只是投影。**
    Claude 那边一行写坏就整块不可见；kvspace 那边标题和摘要是普通节点，索引由
    `kvmem render` 重建，漏项会被捞回来，标题行之类的非索引行也只是跳过。

### 这样切换来什么

结构走路径而不是塞进单个值，直接对应 Claude 侧的三处不便：

| Claude 侧的做法 | kvspace 侧的做法 |
|---|---|
| 读索引要打开 `MEMORY.md`，取一条记忆要读整个 `.md` | 只取 `title` + `desc` 两个节点就能生成索引，不碰 `body` |
| 改一次引用计数要重写整个文件 | `use` 只 `writeInPlace` `meta/uses` 那 8 字节 |
| "某项目的全部记忆"靠 `readdir` 目录 | 一次 `/mem/<scope>/` 前缀列举，天然按 kind 分层 |

## 两个口子

`kvmem` CLI：

```
kvmem put <scope>/<kind>/<slug> [--title T] [--desc D] [--body-file F|-] [--meta k=v]…
kvmem get <scope>/<kind>/<slug> [--json]
kvmem ls <scope>[/<kind>] [--json]        # 输出与 MEMORY.md 同形
kvmem search <scope>[/<kind>] <关键词>
kvmem use <scope>/<kind>/<slug>
kvmem rm <scope>/<kind>/<slug>

kvmem import [--dry-run] [--force]        # 一次性种子：本地 .md → kvspace
kvmem render [--dry-run]                  # 投影：kvspace → 本地 .md + MEMORY.md
kvmem status
kvmem mcp                                 # MCP stdio server
```

公共参数：`--scope S`、`--project P`（默认 `cwd`，slug 由它推导）、
`--kvspace DSN`（默认 `$KVSPACE`，再默认 `redis://127.0.0.1:6379`）。

MCP server（`kvmem mcp`）把五个记忆动作暴露为 `mem_ls` / `mem_get` /
`mem_search` / `mem_put` / `mem_use`。仓内附了一份项目级 `.mcp.json`。
它写下去的也是 kvspace——不需要任何本地目录。

## 迁移与投影

`kvmem import` 是一次性种子，不是同步：它把已有的 `memory/` 目录走一遍，只补
kvspace 缺的那些。kvspace 已有的记忆默认跳过，因为本地文件对真相没有裁决权；
`--force` 才覆盖。`import` 绝不改本地文件，也不留任何状态。

`kvmem render` 是本地记忆文件的唯一写者。它重写每个 `<slug>.md`，清掉 kvspace
不认识的本地 `.md`，并重建 `MEMORY.md`。`--dry-run` 只报计划不动手。

索引顺序住在 kvspace（`meta/order`），所以 `kvmem put` / `mem_put` 写的新记忆
落在索引末尾，不再插到头部。

## 降级

kvspace 不可用时适配器不罢工：

- 读（`ls` / `get` / `search`）降级读本地投影，并在 stderr 声明（MCP 返回文本
  前缀 `[降级…]`）；
- 写（`put` / `use`）追加进
  `<CLAUDE_CONFIG_DIR>/.kvmem/pending.jsonl`，重连后回放；
- 没有投影可降时直接报错，不返回空结果。

降级读的新鲜度等于最后一次 `render`。

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
npm test          # 10 项验收，自包含（临时 CLAUDE_CONFIG_DIR）
```

`test/e2e.ts` 跑在真实后端上，但只用临时 scope，不碰真实记忆与真实 scope。

## 本工作区 113 条记忆上的实测

- `import` 一趟把 113 条全部搬进 kvspace，本地文件逐字节未动。其中包含
  `MEMORY.md` 首行是 `# Memory Index` 标题的那个 scope。
- `kvmem ls` 逐行重现 `MEMORY.md`，并补回索引漏掉的那一条。
- `render` 逐字节重现 **114 个文件中的 109 个**（113 条记忆 + `MEMORY.md`）。
  5 个例外是 `MEMORY.md`（补回的那条索引行）与 4 个 `.md`：3 处 `metadata:` 与
  `metadata: ` 的尾空格差异、1 处 frontmatter 键序差异，语义等价。键序是规范化
  的：`name`、`description`、
  `metadata.{node_type, type, project, originSessionId, created, modified}`。

## 已知残留

slug 里若含 `)` 或换行，`MEMORY.md` 的索引行无法表示它：这类记忆经
`kvmem ls` / `get` 照常可用（kvspace 是真相），但投影行解析不出来，降级读时标题
退回 slug。禁掉这些字符的方案已被否掉，只禁 `/` 与 `·`。
