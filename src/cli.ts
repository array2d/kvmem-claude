#!/usr/bin/env node
import fs from 'node:fs';
import { KINDS, isKind, orderOf, type Kind, type Memory } from './mem.ts';
import { memoryDir, projectSlug, readLocal, renderIndex, renderMemoryText } from './claude.ts';
import { journalCount, openStore, pendingPath, RemoteStore } from './store.ts';
import { runExport, runImport, runSync, statePathOf, type SyncOptions } from './sync.ts';

const USAGE = `kvmem —— kvspace 记忆（Claude Code 适配器 / 参考实现）

记忆面
  kvmem put <scope>/<kind>/<slug> [--title T] [--desc D] [--body-file F|-] [--meta k=v]…
  kvmem get <scope>/<kind>/<slug> [--json]
  kvmem ls <scope>[/<kind>] [--json]
  kvmem search <scope>[/<kind>] <关键词>
  kvmem use <scope>/<kind>/<slug>
  kvmem rm <scope>/<kind>/<slug>

Claude Code 同步（scope 取 --scope，或由 --project 目录名推导）
  kvmem import [--dry-run] [--prefer local]
  kvmem export [--dry-run] [--prefer remote]
  kvmem sync   [--dry-run] [--prefer local|remote]
  kvmem status

接入
  kvmem mcp                          MCP stdio server（工具=上面五个记忆面动作）

公共参数
  --scope S     记忆 scope（默认由 --project 推导）
  --project P   项目目录（默认 cwd），scope = P 的 Claude 项目 slug
  --kvspace DSN 后端 DSN（默认 $KVSPACE 或 redis://127.0.0.1:6379）

kind ∈ ${KINDS.join(' | ')}`;

const BOOL = new Set(['json', 'dry-run', 'help']);
const KNOWN = new Set([...BOOL, 'scope', 'project', 'kvspace', 'prefer', 'title', 'desc', 'body-file', 'meta']);

type Args = { pos: string[]; flags: Map<string, string[]> };

function parseArgs(argv: string[]): Args {
    const pos: string[] = [];
    const flags = new Map<string, string[]>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] as string;
        if (!a.startsWith('--')) {
            pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (!KNOWN.has(key)) throw new Error(`未知参数 --${key}`);
        let value: string;
        if (eq >= 0) value = a.slice(eq + 1);
        else if (BOOL.has(key)) value = 'true';
        else {
            i += 1;
            if (i >= argv.length) throw new Error(`--${key} 缺参数`);
            value = argv[i] as string;
        }
        flags.set(key, [...(flags.get(key) ?? []), value]);
    }
    return { pos, flags };
}

function one(a: Args, key: string): string | undefined {
    return a.flags.get(key)?.[0];
}

function scopeOf(a: Args): string {
    const s = one(a, 'scope');
    if (s !== undefined) return s;
    return projectSlug(one(a, 'project') ?? process.cwd());
}

function dsnOf(a: Args): string {
    return one(a, 'kvspace') ?? process.env.KVSPACE ?? 'redis://127.0.0.1:6379';
}

/** `<scope>/<kind>/<slug>` → 三段。 */
function splitMemoryPath(p: string): { scope: string; kind: Kind; slug: string } {
    const parts = p.split('/');
    if (parts.length !== 3) throw new Error(`记忆路径必须是 <scope>/<kind>/<slug>：${p}`);
    const [scope, kind, slug] = parts as [string, string, string];
    if (!isKind(kind)) throw new Error(`kind 必须是 ${KINDS.join('/')}：${kind}`);
    return { scope, kind, slug };
}

/** `<scope>/` 或 `<scope>/<kind>` → scope + 可选 kind。 */
function splitScopePath(p: string): { scope: string; kind: Kind | undefined } {
    const parts = p.replace(/\/$/, '').split('/');
    if (parts.length > 2) throw new Error(`必须是 <scope>/ 或 <scope>/<kind>：${p}`);
    const [scope, kind] = parts as [string, string | undefined];
    if (kind !== undefined && !isKind(kind)) throw new Error(`kind 必须是 ${KINDS.join('/')}：${kind}`);
    return { scope: scope as string, kind };
}

function readBody(a: Args): string {
    const f = one(a, 'body-file');
    if (f === undefined) return '';
    return f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8');
}

function syncOptions(a: Args): SyncOptions {
    const prefer = one(a, 'prefer');
    if (prefer !== undefined && prefer !== 'local' && prefer !== 'remote') {
        throw new Error(`--prefer 只能是 local 或 remote：${prefer}`);
    }
    return { dryRun: a.flags.has('dry-run'), prefer: prefer ?? null };
}

function logger(prefix: string): (x: { slug: string; note: string }) => void {
    return ({ slug, note }) => process.stdout.write(`${prefix}${slug}: ${note}\n`);
}

function requireRemote(a: Args): RemoteStore {
    const store = openStore(dsnOf(a));
    if (!(store instanceof RemoteStore)) throw new Error('kvspace 不可用，同步类命令无法降级');
    return store;
}

function printRecord(m: Memory, json: boolean): void {
    if (json) {
        process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
        return;
    }
    process.stdout.write(renderMemoryText(m.slug, { ...m.meta, type: m.kind }, m.body));
    process.stdout.write(`uses: ${m.uses}\n`);
}

function run(cmd: string, a: Args): void {
    switch (cmd) {
        case 'put': {
            const { scope, kind, slug } = splitMemoryPath(a.pos[0] ?? '');
            const now = new Date().toISOString();
            const meta: Record<string, string> = { type: kind, src: 'claude', created: now, updated: now, order: '0' };
            for (const kv of a.flags.get('meta') ?? []) {
                const eq = kv.indexOf('=');
                if (eq < 1) throw new Error(`--meta 需要 k=v：${kv}`);
                meta[kv.slice(0, eq)] = kv.slice(eq + 1);
            }
            meta['type'] = kind;
            meta['updated'] = now;
            const store = openStore(dsnOf(a));
            store.put({
                scope,
                kind,
                slug,
                title: one(a, 'title') ?? slug,
                desc: one(a, 'desc') ?? '',
                body: readBody(a),
                meta,
                uses: 0,
            });
            process.stdout.write(`${scope}/${kind}/${slug} 已写入${store.degraded ? '（降级：进 pending 日志）' : ''}\n`);
            return;
        }
        case 'get': {
            const { scope, kind, slug } = splitMemoryPath(a.pos[0] ?? '');
            const m = openStore(dsnOf(a)).get(scope, kind, slug);
            if (m === null) throw new Error(`无此记忆：${scope}/${kind}/${slug}`);
            printRecord(m, a.flags.has('json'));
            return;
        }
        case 'ls': {
            const { scope, kind } = splitScopePath(a.pos[0] ?? '');
            const refs = openStore(dsnOf(a)).ls(scope, kind);
            if (a.flags.has('json')) process.stdout.write(`${JSON.stringify(refs, null, 2)}\n`);
            else process.stdout.write(refs.length === 0 ? '' : renderIndex(refs));
            return;
        }
        case 'search': {
            const { scope, kind } = splitScopePath(a.pos[0] ?? '');
            const q = a.pos[1];
            if (q === undefined) throw new Error('search 需要关键词');
            const hits = openStore(dsnOf(a)).search(scope, q, kind);
            if (a.flags.has('json')) process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
            else {
                process.stdout.write(renderIndex(hits.map((m) => ({
                    scope: m.scope,
                    kind: m.kind,
                    slug: m.slug,
                    title: m.title,
                    desc: m.desc,
                    order: orderOf(m.meta),
                }))));
            }
            return;
        }
        case 'use': {
            const { scope, kind, slug } = splitMemoryPath(a.pos[0] ?? '');
            const n = openStore(dsnOf(a)).use(scope, kind, slug);
            process.stdout.write(`uses=${n}\n`);
            return;
        }
        case 'rm': {
            const { scope, kind, slug } = splitMemoryPath(a.pos[0] ?? '');
            openStore(dsnOf(a)).rm(scope, kind, slug);
            process.stdout.write(`${scope}/${kind}/${slug} 已删除\n`);
            return;
        }
        case 'import':
        case 'export':
        case 'sync': {
            const scope = scopeOf(a);
            const opt = syncOptions(a);
            const store = requireRemote(a);
            const log = logger(opt.dryRun ? '[dry-run] ' : '');
            if (cmd === 'import') runImport(store.mem, scope, opt, log);
            else if (cmd === 'export') runExport(store.mem, scope, opt, log);
            else runSync(store.mem, scope, opt, log);
            store.close();
            return;
        }
        case 'status': {
            const scope = scopeOf(a);
            const store = requireRemote(a);
            const remote = store.ls(scope);
            const localCount = fs.existsSync(memoryDir(scope)) ? readLocal(scope).length : null;
            const pending = fs.existsSync(pendingPath()) ? journalCount() : 0;
            const state = fs.existsSync(statePathOf(scope)) ? '有' : '无';
            process.stdout.write(`scope          ${scope}\n`);
            process.stdout.write(`记忆目录       ${memoryDir(scope)}${localCount === null ? '（不存在）' : ''}\n`);
            process.stdout.write(`本地记忆       ${localCount ?? '-'}\n`);
            process.stdout.write(`kvspace 记忆   ${remote.length}\n`);
            process.stdout.write(`同步状态文件   ${state}\n`);
            process.stdout.write(`pending 日志   ${pending}\n`);
            store.close();
            return;
        }
        default:
            throw new Error(`未知子命令：${cmd}`);
    }
}

function runCli(argv: string[]): number {
    if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help')) {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    run(argv[0] as string, parseArgs(argv.slice(1)));
    return 0;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv[0] === 'mcp') {
        const a = parseArgs(argv.slice(1));
        const { serve } = await import('./mcp.ts');
        await serve({ dsn: dsnOf(a), scope: scopeOf(a) });
        return;
    }
    process.exitCode = runCli(argv);
}

// `kvmem ls | head` 会提前关掉管道：EPIPE 是调用方的正常收尾，不是错误
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
});

try {
    await main();
} catch (e) {
    process.stderr.write(`kvmem: ${(e as Error).message}\n`);
    process.exitCode = 1;
}
