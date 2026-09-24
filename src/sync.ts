import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MemStore, type Kind, type Memory } from './mem.ts';
import {
    claudeProjectsDir,
    kindOf,
    memoryDir,
    readLocal,
    writeIndex,
    writeLocal,
    type LocalMemory,
} from './claude.ts';

/**
 * 本地 .md ↔ kvspace 的双向同步。
 *
 * 变更判定用**内容哈希**，不用时间戳——git checkout / touch 只改 mtime 不改内容，
 * 用时间戳会把没变的记忆判成冲突。`meta/updated` 与 `meta/src` 只用于冲突报告与人工裁决。
 *
 * 冲突规则（显式，绝不静默覆盖）：
 *   只有一侧变更         → 该侧覆盖另一侧
 *   两侧都变更、无基线   → 冲突：报错退出，须 --prefer local|remote 显式裁决
 *   一侧删除、另一侧未变 → 传播删除
 *   一侧删除、另一侧变更 → 冲突
 *
 * 三个入口的边界：
 *   import  本地 → kvspace，不碰本地任何文件（零本地风险）
 *   export  kvspace → 本地（写文件 + 从 kvspace 重建 MEMORY.md），不删本地、不写 kvspace
 *   sync    双向，含删除传播与冲突检测
 *
 * MEMORY.md 是 kvspace 的投影：export / sync 结束后一律按 kvspace 的 order 重建。
 */

const STATE_VERSION = 1;

export type SyncOptions = { dryRun: boolean; prefer: 'local' | 'remote' | null };
export type Action = { slug: string; note: string };

export class ConflictError extends Error {
    constructor(note: string) {
        super(`冲突：${note}`);
        this.name = 'ConflictError';
    }
}

/**
 * 两侧比对用的规范形。
 *
 * 只含 `.md` 里真有的东西：kind（= metadata.type）、body、meta/*。
 * **不含 title / desc**——它们没有本地载体，只活在 MEMORY.md 这个投影里，
 * 真相在 kvspace。若把索引算进内容，删一次 MEMORY.md 就会把 title 推成 slug。
 * `src`（归属）、`order`（索引顺序）、`uses`（引用计数）是旁路字段，同样不参与。
 */
type Canon = { kind: Kind; body: string; meta: Record<string, string> };

const VOLATILE = new Set(['order', 'uses', 'src']);

function hash(c: Canon): string {
    const meta = Object.entries(c.meta)
        .filter(([k]) => !VOLATILE.has(k))
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return crypto.createHash('sha256').update(JSON.stringify([c.kind, c.body, meta])).digest('hex');
}

export function canonLocal(lm: LocalMemory): Canon {
    return { kind: kindOf(lm.meta, `${lm.slug}.md`), body: lm.body, meta: lm.meta };
}

function canonRemote(m: Memory): Canon {
    return { kind: m.kind, body: m.body, meta: m.meta };
}

/**
 * 本地 → kvspace 的记录。
 * title / desc 是索引面：kvspace 已有则沿用（prev），否则用索引行、再不然退回 slug / description。
 */
export function toMemory(scope: string, lm: LocalMemory, prev?: Memory): Memory {
    const c = canonLocal(lm);
    const order = lm.order ?? (prev?.meta['order'] === undefined ? null : Number(prev.meta['order']));
    return {
        scope,
        kind: c.kind,
        slug: lm.slug,
        title: prev?.title ?? lm.title ?? lm.slug,
        desc: prev?.desc ?? lm.desc ?? lm.meta['description'] ?? '',
        body: c.body,
        meta: order === null ? { ...c.meta, src: 'claude' } : { ...c.meta, src: 'claude', order: String(order) },
        uses: prev?.uses ?? 0,
    };
}

function toLocal(m: Memory): LocalMemory {
    const meta = { ...m.meta };
    delete meta['src'];
    delete meta['order'];
    return {
        slug: m.slug,
        meta,
        body: m.body,
        title: m.title,
        desc: m.desc,
        order: m.meta['order'] === undefined ? null : Number(m.meta['order']),
        mtimeMs: Date.parse(m.meta['updated'] ?? ''),
    };
}

type StateEntry = { local: string; remote: string };
type State = { version: number; scope: string; entries: Record<string, StateEntry> };

export function statePathOf(scope: string): string {
    return path.join(claudeProjectsDir(), scope, '.kvmem', 'state.json');
}

function loadState(scope: string): State {
    const p = statePathOf(scope);
    if (!fs.existsSync(p)) return { version: STATE_VERSION, scope, entries: {} };
    const s = JSON.parse(fs.readFileSync(p, 'utf8')) as State;
    if (s.version !== STATE_VERSION || s.scope !== scope) throw new Error(`状态文件版本/scope 不符：${p}`);
    return s;
}

function saveState(scope: string, s: State): void {
    const p = statePathOf(scope);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
}

function remoteBySlug(store: MemStore, scope: string): Map<string, Memory> {
    const out = new Map<string, Memory>();
    for (const ref of store.list(scope)) {
        const m = store.get(ref.scope, ref.kind, ref.slug);
        if (m === null) throw new Error(`索引含 ${ref.slug} 但读不到值`);
        if (out.has(ref.slug)) throw new Error(`同一 scope 内 slug 重复：${ref.slug}`);
        out.set(ref.slug, m);
    }
    return out;
}

function localBySlug(scope: string): Map<string, LocalMemory> {
    const out = new Map<string, LocalMemory>();
    for (const lm of readLocal(scope)) {
        if (out.has(lm.slug)) throw new Error(`本地 slug 重复：${lm.slug}`);
        out.set(lm.slug, lm);
    }
    return out;
}

/** MEMORY.md 由 kvspace 重建——索引是投影，不是真相源。 */
function rebuildIndex(store: MemStore, scope: string, opt: SyncOptions, log: (a: Action) => void): void {
    log({ slug: '(index)', note: '← kvspace  重建 MEMORY.md' });
    if (!opt.dryRun) writeIndex(scope, store.list(scope));
}

function push(store: MemStore, m: Memory, opt: SyncOptions, log: (a: Action) => void): void {
    log({ slug: m.slug, note: `→ kvspace  ${m.kind}/${m.slug}` });
    if (!opt.dryRun) store.put(m);
}

function pull(scope: string, m: Memory, opt: SyncOptions, log: (a: Action) => void): void {
    log({ slug: m.slug, note: `← kvspace  ${m.kind}/${m.slug}` });
    if (!opt.dryRun) writeLocal(scope, toLocal(m));
}

function force(opt: SyncOptions, note: string, want: 'local' | 'remote'): void {
    if (opt.prefer !== want) throw new ConflictError(note);
}

/** 单侧推：本地 → kvspace。只认本地为准，kvspace 侧动过就报冲突（除非 --prefer local）。 */
export function runImport(store: MemStore, scope: string, opt: SyncOptions, log: (a: Action) => void): void {
    const state = loadState(scope);
    const remote = remoteBySlug(store, scope);
    const locals = localBySlug(scope);
    for (const [slug, lm] of locals) {
        const r = remote.get(slug);
        const hL = hash(canonLocal(lm));
        const hR = r === undefined ? null : hash(canonRemote(r));
        const s = state.entries[slug];
        if (hR !== null && hR !== hL && (s === undefined || s.remote !== hR)) {
            force(opt, `${slug}：kvspace 侧内容不同（import 不覆盖）`, 'local');
        }
        push(store, toMemory(scope, lm, r), opt, log);
        state.entries[slug] = { local: hL, remote: hL };
    }
    if (!opt.dryRun) saveState(scope, state);
}

/** 单侧拉：kvspace → 本地。只认 kvspace 为准，本地动过就报冲突（除非 --prefer remote）。 */
export function runExport(store: MemStore, scope: string, opt: SyncOptions, log: (a: Action) => void): void {
    const state = loadState(scope);
    const remote = remoteBySlug(store, scope);
    const locals = localBySlug(scope);
    for (const [slug, m] of remote) {
        const lm = locals.get(slug);
        const hR = hash(canonRemote(m));
        const hL = lm === undefined ? null : hash(canonLocal(lm));
        const s = state.entries[slug];
        if (hL !== null && hL !== hR && (s === undefined || s.local !== hL)) {
            force(opt, `${slug}：本地侧内容不同（export 不覆盖）`, 'remote');
        }
        pull(scope, m, opt, log);
        state.entries[slug] = { local: hR, remote: hR };
    }
    if (!opt.dryRun) saveState(scope, state);
    rebuildIndex(store, scope, opt, log);
}

export function runSync(store: MemStore, scope: string, opt: SyncOptions, log: (a: Action) => void): void {
    const state = loadState(scope);
    const remote = remoteBySlug(store, scope);
    const locals = localBySlug(scope);
    const known = Object.keys(state.entries).length;
    if (remote.size === 0 && known > 0) {
        throw new Error(`kvspace 侧空而状态文件有 ${known} 条记录——` +
            `拒绝把 ${known} 条本地记忆当作"远端已删除"清掉。确认后端无误后删除 ${statePathOf(scope)}`);
    }
    const slugs = [...new Set([...locals.keys(), ...remote.keys(), ...Object.keys(state.entries)])].sort();
    for (const slug of slugs) {
        const lm = locals.get(slug);
        const r = remote.get(slug);
        const s = state.entries[slug];
        const hL = lm === undefined ? null : hash(canonLocal(lm));
        const hR = r === undefined ? null : hash(canonRemote(r));
        const localChanged = lm !== undefined && (s === undefined || s.local !== hL);
        const remoteChanged = r !== undefined && (s === undefined || s.remote !== hR);
        let settled: string | null = null;

        if (lm !== undefined && r !== undefined) {
            if (hL === hR) {
                log({ slug, note: '= 已同步' });
                settled = hL as string;
            } else if (!localChanged) {
                pull(scope, r, opt, log);
                settled = hR as string;
            } else if (!remoteChanged) {
                push(store, toMemory(scope, lm, r), opt, log);
                settled = hL as string;
            } else {
                force(opt, `${slug}：两侧都变更（本地 updated=${lm.meta['updated']} / ` +
                    `kvspace updated=${r.meta['updated']} src=${r.meta['src']}）`, 'local');
                const localWins = opt.prefer === 'local';
                if (localWins) push(store, toMemory(scope, lm, r), opt, log);
                else pull(scope, r, opt, log);
                settled = (localWins ? hL : hR) as string;
            }
        } else if (lm !== undefined) {
            if (s === undefined || localChanged) {
                if (s !== undefined) force(opt, `${slug}：kvspace 侧已删除而本地有改动`, 'local');
                push(store, toMemory(scope, lm), opt, log);
                settled = hL as string;
            } else {
                log({ slug, note: '× 删除本地  kvspace 侧已删除' });
                if (!opt.dryRun) fs.rmSync(path.join(memoryDir(scope), `${slug}.md`));
            }
        } else if (r !== undefined) {
            if (s === undefined || remoteChanged) {
                if (s !== undefined) force(opt, `${slug}：本地已删除而 kvspace 侧有改动`, 'remote');
                pull(scope, r, opt, log);
                settled = hR as string;
            } else {
                log({ slug, note: '× 删除 kvspace  本地已删除' });
                if (!opt.dryRun) store.del(r.scope, r.kind, r.slug);
            }
        } else {
            log({ slug, note: '- 两侧都无，清状态' });
        }

        if (settled === null) delete state.entries[slug];
        else state.entries[slug] = { local: settled, remote: settled };
    }
    if (!opt.dryRun) saveState(scope, state);
    rebuildIndex(store, scope, opt, log);
}
