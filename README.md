# kvmem-claude

Claude Code adapter for the kvspace memory layer. This repo is the **reference
implementation** for the four agent adapters (Claude Code / Codex / Pi / DSH) —
the format mapping below is frozen here and the other three align to it.

Epic: [array2d/kvmem-claude#1](https://github.com/array2d/kvmem-claude/issues/1).
Full plan: `KVSPACE-AGENT-MEMORY.md` in the array2d workspace root.

## Memory key space

```
/mem/<scope>/<kind>/<slug>/
    title     the `[title]` part of a MEMORY.md line
    desc      the part after `— ` in a MEMORY.md line
    body      the markdown body
    meta/     type src created updated uses description order name node_type project originSessionId
```

Structure lives in the path, not inside a single value: entries can be
prefix-queried, single fields updated, and an index can be produced by reading
`title` + `desc` without touching `body`. `scope` is the isolation boundary, so
it is a path segment rather than a metadata field. `kind` is one of
`user | feedback | project | reference`.

Values are `[n]char/utf8` except `meta/uses`, which is `int64`.

## Format mapping (frozen)

| Claude Code | kvspace |
|---|---|
| project directory slug | `<scope>` |
| `<slug>.md` filename | `<slug>` |
| frontmatter `name` | `meta/name` |
| frontmatter `description` | `meta/description` |
| frontmatter `metadata.type` | `<kind>` **and** `meta/type` |
| frontmatter `metadata.<key>` | `meta/<key>` (scalar text kept verbatim) |
| frontmatter `metadata.modified` | `meta/updated` |
| body after the frontmatter block | `body` |
| `MEMORY.md` `- [title](<slug>.md) — hook` → `[title]` | `title` |
| `MEMORY.md` → `hook` | `desc` |
| `MEMORY.md` line number | `meta/order` |
| — | `meta/src` = `claude` |
| — | `meta/uses` (int64, `kvmem use` bumps it) |

`<scope>` is the project slug Claude Code itself uses: the absolute project
path with `/` and `.` replaced by `-` (`/home/u/github.com/x` →
`-home-u-github-com-x`). All four adapters must derive the same scope string
for the same project, otherwise their memories do not meet.

Four rules the mapping obeys:

- **`MEMORY.md` is a projection, not a truth source.** `kvmem ls` prints
  exactly its content, and `import` / `export` / `sync` rebuild it from
  kvspace. A memory file that is missing from the index is therefore recovered
  by the rebuild rather than staying invisible.
- **`title` / `desc` have no local carrier.** They only exist in `MEMORY.md`,
  so their truth lives in kvspace. They take no part in change detection — if
  they did, deleting `MEMORY.md` once would push every `title` back to its slug.
- **The filename is the identity**, not `frontmatter.name`. Two of the 113
  memories in the workspace already disagree; `name` is preserved verbatim
  under `meta/name` rather than used as a key.
- **Absent stays absent.** No timestamp, title or description is fabricated for
  a field the source file does not have.

## Two interfaces

`kvmem` CLI:

```
kvmem put <scope>/<kind>/<slug> [--title T] [--desc D] [--body-file F|-] [--meta k=v]…
kvmem get <scope>/<kind>/<slug> [--json]
kvmem ls <scope>[/<kind>] [--json]        # prints MEMORY.md-shaped lines
kvmem search <scope>[/<kind>] <keyword>
kvmem use <scope>/<kind>/<slug>
kvmem rm <scope>/<kind>/<slug>

kvmem import [--dry-run] [--prefer local]     # local .md → kvspace
kvmem export [--dry-run] [--prefer remote]    # kvspace → local .md + MEMORY.md
kvmem sync   [--dry-run] [--prefer local|remote]
kvmem status
kvmem mcp                                     # MCP stdio server
```

Common flags: `--scope S`, `--project P` (default `cwd`, slug derived from it),
`--kvspace DSN` (default `$KVSPACE`, else `redis://127.0.0.1:6379`).

MCP server (`kvmem mcp`) exposes the five memory actions as `mem_ls`, `mem_get`,
`mem_search`, `mem_put`, `mem_use`. A project-scoped `.mcp.json` is included.

## Sync rules

Change detection uses a **content hash**, not timestamps: `git checkout`/`touch`
only move mtime, and comparing timestamps would call unchanged memories
conflicts. `meta/updated` and `meta/src` are reported when a conflict has to be
resolved by hand.

```
only one side changed          → that side wins
both sides changed, no baseline → conflict: exit non-zero, print both updated/src
one side deleted, other unchanged → propagate the deletion
one side deleted, other changed   → conflict
```

Conflicts require an explicit `--prefer local|remote`; nothing is silently
overwritten. `import` never touches local files (zero local risk) and `export`
never touches kvspace.

Sync state lives in `<CLAUDE_CONFIG_DIR>/projects/<scope>/.kvmem/state.json` —
outside `memory/`, so the memory directory layout Claude Code expects is
untouched.

## Degradation

When kvspace is unreachable the adapter does not refuse to work:

- reads (`ls` / `get` / `search`) fall back to the local `.md` files, and the
  fallback is announced on stderr (MCP responses are prefixed with
  `[降级…]`);
- writes (`put` / `use`) are appended to `<CLAUDE_CONFIG_DIR>/.kvmem/pending.jsonl`
  and replayed on the next successful connection;
- if there is no local memory directory for that scope, there is nothing to
  degrade to — the command fails with an error instead of returning an empty
  result.

## Requirements

- Node ≥ 23 (runs `.ts` directly, no build step)
- `libkvspace.so.1` on the loader path (the dispatch front end; backends are
  loaded from `/usr/lib/kvspace` per DSN scheme: `shm://` → kvspace-c,
  `redis://` / `fs://` → kvspace-durable)
- The adapter always talks to the front end and never links a backend directly.
- One ABI caveat to be aware of: on the durable backends the last write of a
  short-lived process only lands on `kvspaceClose` (array2d/kvspace#23). Every
  store this adapter opens is closed from a process exit hook
  (`src/store.ts`), and the e2e checks all cross a process boundary, so a
  regression here fails the suite.

```
npm install
node src/cli.ts --help
npm test          # 12 acceptance checks, self-contained (temp CLAUDE_CONFIG_DIR)
```

`test/e2e.ts` runs against the live backend with a temporary scope; it does not
touch real memories or real scopes.

## Measured on the 113 memories in this workspace

- `import` puts 112 memories / 113 files (the 113th is `MEMORY.md`) into
  kvspace; local files are byte-identical afterwards.
- `kvmem ls` reproduces `MEMORY.md` line for line, plus one entry that the
  index was missing.
- Round-trip `export` reproduces **109 of 113** `.md` files byte-identically.
  The 4 exceptions are three `metadata:` vs `metadata: ` trailing-space
  differences and one frontmatter key ordering difference — semantically equal
  either way. Field order is canonical: `name`, `description`,
  `metadata.{node_type, type, project, originSessionId, created, modified}`.
