import fs from 'node:fs';
import path from 'node:path';

import { KVSpace } from './kvspace.ts';
import { MemStore, byOrder, orderOf, type Kind, type Memory, type MemRef } from './mem.ts';
import { claudeHome, memoryDir, readLocal } from './claude.ts';
import { toMemory } from './sync.ts';

/**
 * 记忆面的两个实现。
 *
 *   RemoteStore  kvspace（真相源）
 *   LocalStore   后端不可用时的降级：读本地 .md，写操作进 pending 日志，重连后回放
 *
 * 降级要求该 scope 有本地记忆目录（Claude Code 有，其它 agent 未必）——`readLocal` 会直接报错，
 * 所以"没有记忆目录"是硬故障而不是空结果：空结果与故障不可混为一谈。
 */

export interface Store {
    readonly degraded: boolean;
    ls(scope: string, kind?: Kind): MemRef[];
    get(scope: string, kind: Kind, slug: string): Memory | null;
    search(scope: string, needle: string, kind?: Kind): Memory[];
    put(m: Memory): void;
    use(scope: string, kind: Kind, slug: string): number;
    rm(scope: string, kind: Kind, slug: string): void;
}

export type Pending = { op: 'put'; memory: Memory } | { op: 'use'; scope: string; kind: Kind; slug: string };

export function pendingPath(): string {
    return path.join(claudeHome(), '.kvmem', 'pending.jsonl');
}

/**
 * durable 后端惰性 flush：最后一笔写要等下一次 ABI 调用或 `kvspaceClose` 才落盘，
 * 进程退出前不 close 就会静默丢它（array2d/kvspace#23，shm 后端无此问题）。
 * 这里的进程级退出钩子是唯一的兜底；test/e2e.ts 每次断言都跨进程，正是它的回归守卫。
 */
const OPEN = new Set<RemoteStore>();
let hooked = false;

function hookExit(): void {
    if (hooked) return;
    hooked = true;
    process.on('exit', () => {
        for (const s of OPEN) s.close();
    });
}

export class RemoteStore implements Store {
    readonly degraded = false;
    readonly mem: MemStore;
    #kv: KVSpace;

    constructor(dsn: string) {
        this.#kv = new KVSpace(dsn);
        this.mem = new MemStore(this.#kv);
        OPEN.add(this);
        hookExit();
    }

    close(): void {
        if (!OPEN.delete(this)) return;
        this.#kv.close();
    }

    ls(scope: string, kind?: Kind): MemRef[] {
        return this.mem.list(scope, kind);
    }

    get(scope: string, kind: Kind, slug: string): Memory | null {
        return this.mem.get(scope, kind, slug);
    }

    search(scope: string, needle: string, kind?: Kind): Memory[] {
        return this.mem.search(scope, needle, kind);
    }

    put(m: Memory): void {
        this.mem.put(m);
    }

    use(scope: string, kind: Kind, slug: string): number {
        return this.mem.use(scope, kind, slug);
    }

    rm(scope: string, kind: Kind, slug: string): void {
        this.mem.del(scope, kind, slug);
    }
}

function journalAppend(p: Pending): void {
    const f = pendingPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify(p)}\n`);
}

export function journalCount(): number {
    return journalRead().length;
}

function journalRead(): Pending[] {
    const f = pendingPath();
    if (!fs.existsSync(f)) return [];
    return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Pending);
}

export class LocalStore implements Store {
    readonly degraded = true;

    ls(scope: string, kind?: Kind): MemRef[] {
        return readLocal(scope)
            .map((lm) => {
                const m = toMemory(scope, lm);
                return {
                    scope,
                    kind: m.kind,
                    slug: m.slug,
                    title: m.title,
                    desc: m.desc,
                    order: orderOf(m.meta),
                };
            })
            .filter((r) => kind === undefined || r.kind === kind)
            .sort(byOrder);
    }

    get(scope: string, kind: Kind, slug: string): Memory | null {
        const lm = readLocal(scope).find((x) => x.slug === slug);
        if (lm === undefined) return null;
        const m = toMemory(scope, lm);
        if (m.kind !== kind) throw new Error(`${slug} 的 kind 是 ${m.kind}，不是 ${kind}`);
        return m;
    }

    search(scope: string, needle: string, kind?: Kind): Memory[] {
        const q = needle.toLowerCase();
        const out: Memory[] = [];
        for (const r of this.ls(scope, kind)) {
            const m = this.get(scope, r.kind, r.slug);
            if (m === null) throw new Error(`本地索引含 ${r.slug} 但读不到`);
            if ([m.title, m.desc, m.body].some((f) => f.toLowerCase().includes(q))) out.push(m);
        }
        return out;
    }

    put(m: Memory): void {
        journalAppend({ op: 'put', memory: m });
    }

    use(scope: string, kind: Kind, slug: string): number {
        if (this.get(scope, kind, slug) === null) throw new Error(`本地无 ${kind}/${slug}`);
        journalAppend({ op: 'use', scope, kind, slug });
        return 0;
    }

    rm(scope: string, kind: Kind, slug: string): void {
        if (this.get(scope, kind, slug) === null) throw new Error(`本地无 ${kind}/${slug}`);
        fs.rmSync(path.join(memoryDir(scope), `${slug}.md`));
    }
}

/** 连得上 kvspace 就用它（并回放降级期间的写日志）；连不上则降级为本地文件。 */
export function openStore(dsn: string): Store {
    try {
        const remote = new RemoteStore(dsn);
        replay(remote);
        return remote;
    } catch (e) {
        process.stderr.write(`kvmem: kvspace 不可用（${(e as Error).message}）→ 降级为本地文件\n`);
        return new LocalStore();
    }
}

/** 回放降级期间积压的写操作；只有在全部成功后才清日志。 */
function replay(store: RemoteStore): void {
    const pending = journalRead();
    for (const p of pending) {
        if (p.op === 'put') store.put(p.memory);
        else store.use(p.scope, p.kind, p.slug);
    }
    if (pending.length > 0) fs.rmSync(pendingPath());
}
