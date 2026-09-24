import type { Action, MemStore } from './mem.ts';
import { kindOf, readLocal, toMemory } from './claude.ts';

/**
 * 一次性迁移：把已有的本地 `.md` 搬进 kvspace。
 *
 * 这是单向的种子动作，不是同步。kvspace 已有的记忆默认跳过——本地文件此后只是
 * 投影，没有资格覆盖真相；只有 `--force` 才让本地内容覆盖 kvspace 的同名记忆。
 */

export type ImportOptions = { dryRun: boolean; force: boolean };

export function runImport(store: MemStore, scope: string, opt: ImportOptions, log: (a: Action) => void): void {
    const have = new Set(store.list(scope).map((r) => r.slug));
    for (const lm of readLocal(scope)) {
        const prev = opt.force ? store.get(scope, kindOf(lm.meta, `${lm.slug}.md`), lm.slug) : null;
        if (prev === null && have.has(lm.slug)) {
            log({ slug: lm.slug, note: '= kvspace 已有，跳过（--force 才覆盖）' });
            continue;
        }
        const m = toMemory(scope, lm, prev ?? undefined);
        log({ slug: m.slug, note: `→ kvspace  ${m.kind}/${m.slug}` });
        if (!opt.dryRun) store.put(m);
    }
}
