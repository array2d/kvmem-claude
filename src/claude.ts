import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isKind, isSlug, type Kind, type MemRef, type Memory } from './mem.ts';

/**
 * Claude Code 记忆文件 ↔ kvspace 的格式翻译（本仓是参考实现，其余三家照此对齐）。
 *
 *   ~/.claude/projects/<scope>/memory/
 *       MEMORY.md         索引投影：`- [标题](<slug>.md) — 摘要`
 *       <slug>.md         `---` frontmatter（name/description/metadata.*）+ 正文
 *
 * 这两个文件都是 kvspace 的**投影**（`kvmem render` 生成），不是存储：真相只有
 * kvspace 一份。本模块只做双向的格式翻译，不裁决谁更新。
 *
 * 映射：
 *   <slug>.md 文件名          → <slug>（身份；与 frontmatter.name 不一致也照用文件名）
 *   frontmatter.name          → meta/name（原样，不当 key 用）
 *   frontmatter.description   → meta/description
 *   frontmatter.metadata.*    → meta/*（type / node_type / project / originSessionId / created）
 *   frontmatter.metadata.modified → meta/updated
 *   MEMORY.md 行号             → meta/order（顺序住在 kvspace，重建索引时按它排）
 *   MEMORY.md `[标题]`         → title（缺省取 description）
 *   MEMORY.md ` — 摘要`        → desc
 *   frontmatter 之后的正文     → body
 *
 * frontmatter 的标量一律按**原文**存（不解释引号/布尔），往返逐字保真。
 */

const TOP_KEYS = new Set(['name', 'description']);
const META_KEYS = new Set(['type', 'node_type', 'project', 'originSessionId', 'created', 'modified']);

/** meta/* 的封闭集合：写入侧只认这些，未知键一律 error。 */
export const META_KEY_ORDER = [
    'node_type',
    'type',
    'project',
    'originSessionId',
    'created',
    'modified',
] as const;

/** Claude Code 配置根：`$CLAUDE_CONFIG_DIR` 优先，否则 `~/.claude`。 */
export function claudeHome(): string {
    return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir(): string {
    return path.join(claudeHome(), 'projects');
}

/** Claude Code 的项目 slug：绝对路径里的 `/` 与 `.` 一律换成 `-`（`/a/b.c` → `-a-b-c`）。 */
export function projectSlug(dir: string): string {
    return path.resolve(dir).replace(/[/.]/g, '-');
}

export function memoryDir(scope: string): string {
    return path.join(claudeProjectsDir(), scope, 'memory');
}

export type LocalMemory = {
    slug: string;
    /** meta/ 字段，值为 frontmatter 标量原文 */
    meta: Record<string, string>;
    body: string;
    /** MEMORY.md 的 `[标题]`；不在索引里则为 null */
    title: string | null;
    /** MEMORY.md 的 `— 摘要`；不在索引里则为 null */
    desc: string | null;
    /** MEMORY.md 行号；不在索引里则为 null */
    order: number | null;
    /** frontmatter 的 modified；缺则 NaN（不编造时间戳）。 */
    mtimeMs: number;
};

export function readLocal(scope: string): LocalMemory[] {
    const dir = memoryDir(scope);
    if (!fs.existsSync(dir)) throw new Error(`记忆目录不存在：${dir}`);
    const index = parseIndex(path.join(dir, 'MEMORY.md'));
    const out: LocalMemory[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
        if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
        const slug = name.slice(0, -3);
        const file = path.join(dir, name);
        const { meta, body } = parseMemoryText(fs.readFileSync(file, 'utf8'), name);
        const line = index.get(slug) ?? null;
        out.push({
            slug,
            meta,
            body,
            title: line?.title ?? null,
            desc: line?.desc ?? null,
            order: line?.order ?? null,
            mtimeMs: meta['updated'] === undefined ? NaN : Date.parse(meta['updated']),
        });
    }
    return out;
}

export function writeLocal(scope: string, m: LocalMemory): void {
    const file = path.join(memoryDir(scope), `${m.slug}.md`);
    fs.writeFileSync(file, renderMemoryText(m.slug, m.meta, m.body));
    if (!Number.isNaN(m.mtimeMs)) fs.utimesSync(file, m.mtimeMs / 1000, m.mtimeMs / 1000);
}

export function writeIndex(scope: string, refs: MemRef[]): void {
    fs.writeFileSync(path.join(memoryDir(scope), 'MEMORY.md'), renderIndex(refs));
}

/** 索引投影：`- [标题](<slug>.md) — 摘要`，与 MEMORY.md 逐字同形。 */
export function renderIndex(refs: MemRef[]): string {
    return refs.map((r) => `- [${r.title}](${r.slug}.md) — ${r.desc}`).join('\n') + '\n';
}

function parseIndex(file: string): Map<string, { title: string; desc: string; order: number }> {
    const out = new Map<string, { title: string; desc: string; order: number }>();
    if (!fs.existsSync(file)) return out;
    let order = 0;
    for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
        const m = INDEX_LINE.exec(line);
        if (m === null) continue;
        const slug = m[2] as string;
        if (!isSlug(slug)) throw new Error(`${file}:${i + 1} 非法 slug：${slug}`);
        out.set(slug, { title: m[1] as string, desc: m[3] as string, order: order++ });
    }
    return out;
}

/** 索引行形如 `- [标题](<slug>.md) — 摘要`；其余行（`# Memory Index` 之类的标题、说明）不是记忆，跳过。 */
const INDEX_LINE = /^- \[(.+?)\]\(([^()]+)\.md\) — (.*)$/;

export function parseMemoryText(text: string, whence: string): { meta: Record<string, string>; body: string } {
    const lines = text.split('\n');
    if (lines[0] !== '---') throw new Error(`${whence}: 首行不是 frontmatter 分隔符`);
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new Error(`${whence}: frontmatter 未闭合`);

    let section: 'top' | 'metadata' = 'top';
    const meta: Record<string, string> = {};
    for (let i = 1; i < end; i++) {
        const line = lines[i] as string;
        if (line.trim() === '') continue;
        const indent = /^( *)([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
        if (indent === null) throw new Error(`${whence}:${i + 1} 无法解析：${JSON.stringify(line)}`);
        const [, spaces, key, rawValue] = indent as unknown as [string, string, string, string];
        const value = rawValue.trimEnd();
        if (spaces !== '') {
            if (spaces !== '  ') throw new Error(`${whence}:${i + 1} 缩进非 2 空格`);
            if (section !== 'metadata') throw new Error(`${whence}:${i + 1} 缩进块不在 metadata 下`);
            if (!META_KEYS.has(key)) throw new Error(`${whence}:${i + 1} 非约定 metadata 键：${key}`);
            meta[key === 'modified' ? 'updated' : key] = value;
            continue;
        }
        if (key === 'metadata') {
            if (value !== '') throw new Error(`${whence}:${i + 1} metadata 不是块`);
            section = 'metadata';
            continue;
        }
        section = 'top';
        if (!TOP_KEYS.has(key)) throw new Error(`${whence}:${i + 1} 非约定 frontmatter 键：${key}`);
        meta[key] = value;
    }
    if (meta['name'] === undefined) throw new Error(`${whence}: frontmatter 缺 name`);
    return { meta, body: lines.slice(end + 1).join('\n').replace(/^\n/, '') };
}

/** 旁路字段：住在 kvspace 但不在 frontmatter 里（src 是归属标记，order 是索引顺序）。 */
const SIDE_META = new Set(['src', 'order', 'uses']);
const FRONT_KEYS = new Set<string>(['name', 'description', 'updated', ...META_KEY_ORDER]);

/** 取 frontmatter 面：剔掉旁路字段，剩下的必须全部是约定键。 */
function frontmatterMeta(slug: string, meta: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
        if (SIDE_META.has(k)) continue;
        if (!FRONT_KEYS.has(k)) throw new Error(`${slug}: meta 含非约定键 ${k}`);
        out[k] = v;
    }
    return out;
}

export function renderMemoryText(slug: string, meta: Record<string, string>, body: string): string {
    frontmatterMeta(slug, meta);
    const t = meta['type'];
    if (t === undefined || !isKind(t)) throw new Error(`${slug}: meta.type 非法: ${t}`);
    const head = ['---', `name: ${meta['name'] ?? slug}`];
    if (meta['description'] !== undefined) head.push(`description: ${meta['description']}`);
    head.push('metadata: '); // 行尾空格是 Claude Code 序列化器的原样（113 个现存记忆里 109 个如此）
    for (const k of META_KEY_ORDER) {
        const v = k === 'type' ? t : k === 'modified' ? meta['updated'] : meta[k];
        if (v !== undefined) head.push(`  ${k}: ${v}`);
    }
    head.push('---');
    return `${head.join('\n')}\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

export function kindOf(meta: Record<string, string>, whence: string): Kind {
    const t = meta['type'];
    if (t === undefined || !isKind(t)) throw new Error(`${whence}: metadata.type 缺失或非法：${t}`);
    return t;
}

/** 本地 .md → kvspace 记忆。title / desc 只活在索引行里，缺则退回 slug / description。 */
export function toMemory(scope: string, lm: LocalMemory, prev?: Memory): Memory {
    const kind = kindOf(lm.meta, `${lm.slug}.md`);
    const order = lm.order ?? (prev?.meta['order'] === undefined ? null : Number(prev.meta['order']));
    const meta: Record<string, string> = { ...lm.meta, src: 'claude' };
    if (order !== null) meta['order'] = String(order);
    return {
        scope,
        kind,
        slug: lm.slug,
        title: prev?.title ?? lm.title ?? lm.slug,
        desc: prev?.desc ?? lm.desc ?? lm.meta['description'] ?? '',
        body: lm.body,
        meta,
        uses: prev?.uses ?? 0,
    };
}

/** kvspace 记忆 → 本地 .md 的投影形态；`src` / `order` 不进 frontmatter。 */
export function toLocal(m: Memory): LocalMemory {
    const meta: Record<string, string> = { ...m.meta };
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
