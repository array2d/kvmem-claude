import { KVSpace, STORETYPE_ATOM } from './kvspace.ts';

/**
 * 记忆的 key 空间（对外契约，四家适配器共同遵守）：
 *
 *   /mem/<scope>/<kind>/<slug>/
 *       title   索引行 `[标题]`（MEMORY.md 的方括号部分）
 *       desc    索引行摘要（MEMORY.md 的 `— ` 之后部分）
 *       body    正文
 *       meta/   type src created updated uses description order …
 *
 * 结构走路径：可前缀查询、可单字段更新、可只读 title+desc 不取 body。
 * scope 是隔离边界，进路径不进字段。
 */

export const MEM_ROOT = '/mem';
export const KINDS = ['user', 'feedback', 'project', 'reference'] as const;
export type Kind = (typeof KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(KINDS);
export function isKind(s: string): s is Kind {
    return KIND_SET.has(s);
}

const SCOPE_RE = /^[A-Za-z0-9._-]+$/;
/** slug 同时是文件名（`<slug>.md`）与 kvspace 路径段，故禁 `/` 与 `.`；大小写不限（现存 README-no-hype）。 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const META_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isSlug(s: string): boolean {
    return SLUG_RE.test(s);
}

export type Memory = {
    scope: string;
    kind: Kind;
    slug: string;
    title: string;
    desc: string;
    body: string;
    /** meta/ 下的字符串字段（type/src/created/updated/description/order/…） */
    meta: Record<string, string>;
    /** meta/uses，int64 计数器；记忆被引用一次 +1 */
    uses: number;
};

/** 索引视图：`ls`/MEMORY.md 只需要这些字段，不读 body。 */
export type MemRef = {
    scope: string;
    kind: Kind;
    slug: string;
    title: string;
    desc: string;
    order: number | null;
};

export function entryKey(scope: string, kind: Kind, slug: string): string {
    assertScope(scope);
    assertSlug(slug);
    return `${MEM_ROOT}/${scope}/${kind}/${slug}`;
}

function scopeKey(scope: string): string {
    assertScope(scope);
    return `${MEM_ROOT}/${scope}/`;
}

function assertScope(scope: string): void {
    if (!SCOPE_RE.test(scope)) throw new Error(`非法 scope：${JSON.stringify(scope)}`);
}

function assertSlug(slug: string): void {
    if (!isSlug(slug)) throw new Error(`非法 slug（字母数字开头的 kebab-case）：${JSON.stringify(slug)}`);
}

function assertMetaKey(k: string): void {
    if (!META_KEY_RE.test(k)) throw new Error(`非法 meta 键：${JSON.stringify(k)}`);
}

/** meta/order → 索引顺序号；不在索引里的记忆没有 order，排在最后。 */
export function orderOf(meta: Record<string, string>): number | null {
    const v = meta['order'];
    return v === undefined ? null : Number(v);
}

/** 按 `order` 升序；无 order 的排在后，按 slug 定序。 */
export function byOrder(a: MemRef, b: MemRef): number {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

export class MemStore {
    #kv: KVSpace;

    constructor(kv: KVSpace) {
        this.#kv = kv;
    }

    get kv(): KVSpace {
        return this.#kv;
    }

    /** 整体替换一条记忆：先删子树再写全字段，不留半旧状态。 */
    put(m: Memory): void {
        const p = entryKey(m.scope, m.kind, m.slug);
        if (m.meta['type'] !== m.kind) {
            throw new Error(`meta.type(${m.meta['type']}) 与 kind(${m.kind}) 不一致：${m.slug}`);
        }
        this.#kv.delTree(`${p}/`);
        this.#kv.putString(`${p}/title`, m.title);
        this.#kv.putString(`${p}/desc`, m.desc);
        this.#kv.putString(`${p}/body`, m.body);
        for (const [k, v] of Object.entries(m.meta)) {
            assertMetaKey(k);
            this.#kv.putString(`${p}/meta/${k}`, v);
        }
        this.#kv.putInt64(`${p}/meta/uses`, BigInt(m.uses));
    }

    get(scope: string, kind: Kind, slug: string): Memory | null {
        const p = entryKey(scope, kind, slug);
        const title = this.#str(`${p}/title`);
        if (title === null) return null;
        const meta: Record<string, string> = {};
        for (const name of this.#kv.list(`${p}/meta/`)) {
            const key = name.replace(/\/$/, '');
            if (key === 'uses') continue;
            const v = this.#str(`${p}/meta/${key}`);
            if (v === null) throw new Error(`meta/${key} 声明为目录项但读不到值：${p}`);
            meta[key] = v;
        }
        return {
            scope,
            kind,
            slug,
            title,
            desc: this.#str(`${p}/desc`) ?? '',
            body: this.#str(`${p}/body`) ?? '',
            meta,
            uses: this.#int(`${p}/meta/uses`) ?? 0,
        };
    }

    /** scope 下（可选 kind 下）全部记忆的索引视图，按 order 升序。 */
    list(scope: string, kind?: Kind): MemRef[] {
        const kinds: Kind[] = kind === undefined ? this.kinds(scope) : [kind];
        const out: MemRef[] = [];
        for (const k of kinds) {
            for (const slug of this.slugs(scope, k)) {
                const p = entryKey(scope, k, slug);
                const title = this.#str(`${p}/title`);
                if (title === null) throw new Error(`索引含 ${slug} 但缺 title：${p}`);
                const raw = this.#str(`${p}/meta/order`);
                out.push({
                    scope,
                    kind: k,
                    slug,
                    title,
                    desc: this.#str(`${p}/desc`) ?? '',
                    order: raw === null ? null : Number(raw),
                });
            }
        }
        return out.sort(byOrder);
    }

    search(scope: string, needle: string, kind?: Kind): Memory[] {
        const q = needle.toLowerCase();
        const hits: Memory[] = [];
        for (const ref of this.list(scope, kind)) {
            const m = this.get(ref.scope, ref.kind, ref.slug);
            if (m === null) throw new Error(`索引含 ${ref.slug} 但读不到：${ref.kind}`);
            if ([m.title, m.desc, m.body].some((f) => f.toLowerCase().includes(q))) hits.push(m);
        }
        return hits;
    }

    /** 记一次引用，返回新计数。 */
    use(scope: string, kind: Kind, slug: string): number {
        const key = `${entryKey(scope, kind, slug)}/meta/uses`;
        const cur = this.#int(key);
        if (cur === null) {
            this.#kv.putInt64(key, 1n);
            return 1;
        }
        const next = cur + 1;
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(BigInt(next));
        this.#kv.writeInPlace(key, buf);
        return next;
    }

    del(scope: string, kind: Kind, slug: string): void {
        this.#kv.delTree(`${entryKey(scope, kind, slug)}/`);
    }

    scopes(): string[] {
        return this.#kv.list(`${MEM_ROOT}/`).map((n) => n.replace(/\/$/, ''));
    }

    kinds(scope: string): Kind[] {
        return this.#kv.list(scopeKey(scope)).map((n) => {
            const k = n.replace(/\/$/, '');
            if (!isKind(k)) throw new Error(`${scopeKey(scope)} 下出现非记忆 kind：${k}`);
            return k;
        });
    }

    slugs(scope: string, kind: Kind): string[] {
        return this.#kv.list(`${MEM_ROOT}/${scope}/${kind}/`).map((n) => n.replace(/\/$/, ''));
    }

    #str(key: string): string | null {
        const v = this.#kv.get(key);
        if (v === null) return null;
        if (v.head.storetype !== 2 || !v.head.langtype.endsWith('char/utf8')) {
            throw new Error(`${key} 不是 char/utf8：${v.head.langtype}`);
        }
        return v.body.toString('utf8');
    }

    #int(key: string): number | null {
        const v = this.#kv.get(key);
        if (v === null) return null;
        if (v.head.storetype !== STORETYPE_ATOM || v.head.langtype !== 'int64') {
            throw new Error(`${key} 不是 int64：${v.head.langtype}`);
        }
        return Number(v.body.readBigInt64LE());
    }
}
