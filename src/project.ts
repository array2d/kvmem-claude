import fs from 'node:fs';
import path from 'node:path';
import type { Action, MemStore } from './mem.ts';
import { memoryDir, toLocal, writeIndex, writeLocal } from './claude.ts';

/**
 * kvspace → 本地投影。
 *
 * 本地 `<slug>.md` 与 `MEMORY.md` 都是 kvspace 的派生品，不是第二份存储：本命令
 * 单向重写它们，kvspace 里没有的本地 `.md` 一并清掉。本地目录任何时候都可以整个
 * 删掉，再从 kvspace 重建——这正是「唯一存储」的意思。
 */

export type RenderOptions = { dryRun: boolean };

export function renderProjection(store: MemStore, scope: string, opt: RenderOptions, log: (a: Action) => void): void {
    const dir = memoryDir(scope);
    const refs = store.list(scope);
    const wanted = new Set(refs.map((r) => r.slug));

    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
        const slug = name.slice(0, -3);
        if (wanted.has(slug)) continue;
        log({ slug, note: '× 删除投影  kvspace 侧没有' });
        if (!opt.dryRun) fs.rmSync(path.join(dir, name));
    }
    if (!opt.dryRun) fs.mkdirSync(dir, { recursive: true });
    for (const ref of refs) {
        const m = store.get(ref.scope, ref.kind, ref.slug);
        if (m === null) throw new Error(`索引含 ${ref.slug} 但读不到值`);
        log({ slug: m.slug, note: `← kvspace  ${m.kind}/${m.slug}` });
        if (!opt.dryRun) writeLocal(scope, toLocal(m));
    }
    log({ slug: '(index)', note: '← kvspace  重建 MEMORY.md' });
    if (!opt.dryRun) writeIndex(scope, refs);
}
