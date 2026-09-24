import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KINDS, orderOf, type Kind, type Memory } from './mem.ts';
import { renderIndex, renderMemoryText } from './claude.ts';
import { nextOrder, openStore, RemoteStore, type Store } from './store.ts';

/**
 * kvmem MCP server（stdio）。
 *
 * 只暴露五个记忆面动作，形状与 `kvmem` CLI 一一对应——适配器只做格式翻译，不改 agent 自己的格式。
 * kvspace 是唯一存储：本地 .md 只是 `kvmem render` 生成的投影，写一律落 kvspace。
 * 后端不可用时按 scope 降级读本地文件；降级状态在返回文本里显式标出，不静默。
 * 故障绝不返回空结果：连本地文件也没有时抛出错误。
 */

export type ServeOptions = { dsn: string; scope: string };

const TEXT = (text: string) => ({ content: [{ type: 'text' as const, text }] });

function asLines(m: Memory[]): string {
    if (m.length === 0) return '无记忆';
    return renderIndex(
        m.map((x) => ({
            scope: x.scope,
            kind: x.kind,
            slug: x.slug,
            title: x.title,
            desc: x.desc,
            order: orderOf(x.meta),
        })),
    );
}

function asRecord(m: Memory): string {
    return `${renderMemoryText(m.slug, { ...m.meta, type: m.kind }, m.body)}uses: ${m.uses}\n`;
}

export async function serve(opt: ServeOptions): Promise<void> {
    let cached: Store | null = null;

    function store(): Store {
        if (cached === null) cached = openStore(opt.dsn);
        return cached;
    }

    function call(fn: (s: Store) => string): string {
        try {
            const s = store();
            return (s.degraded ? '[降级：kvspace 不可用，读本地文件] ' : '') + fn(s);
        } catch (e) {
            if (cached instanceof RemoteStore) {
                cached.close();
                cached = null;
            }
            throw e;
        }
    }

    const scopeArg = z.string().optional().describe(`记忆 scope；默认 ${opt.scope}`);
    const kindArg = z.enum(KINDS).describe('记忆种类');
    const server = new McpServer({ name: 'kvmem', version: '0.1.0' });

    server.registerTool(
        'mem_ls',
        {
            title: '列出记忆',
            description: '列出某 scope（可限定 kind）的记忆索引行，形如 `- [标题](<slug>.md) — 摘要`。',
            inputSchema: { scope: scopeArg, kind: kindArg.optional() },
        },
        ({ scope, kind }) =>
            TEXT(
                call((s) => {
                    const refs = s.ls(scope ?? opt.scope, kind as Kind | undefined);
                    return refs.length === 0 ? `无记忆：${scope ?? opt.scope}` : renderIndex(refs);
                }),
            ),
    );

    server.registerTool(
        'mem_get',
        {
            title: '读取一条记忆',
            description: '取回一条记忆：标题、摘要、meta/*、正文。',
            inputSchema: { slug: z.string(), scope: scopeArg, kind: kindArg },
        },
        ({ scope, kind, slug }) =>
            TEXT(
                call((s) => {
                    const m = s.get(scope ?? opt.scope, kind as Kind, slug);
                    if (m === null) throw new Error(`无此记忆：${scope ?? opt.scope}/${kind}/${slug}`);
                    return asRecord(m);
                }),
            ),
    );

    server.registerTool(
        'mem_search',
        {
            title: '检索记忆',
            description: '在某 scope（可限定 kind）内按关键词检索标题、摘要、正文。',
            inputSchema: { query: z.string(), scope: scopeArg, kind: kindArg.optional() },
        },
        ({ scope, kind, query }) =>
            TEXT(call((s) => asLines(s.search(scope ?? opt.scope, query, kind as Kind | undefined)))),
    );

    server.registerTool(
        'mem_put',
        {
            title: '写入一条记忆',
            description: '写入/整体替换一条记忆（结构走路径：/mem/<scope>/<kind>/<slug>/）。',
            inputSchema: {
                slug: z.string().describe('kebab-case'),
                kind: kindArg,
                body: z.string(),
                title: z.string().optional(),
                desc: z.string().optional(),
                scope: scopeArg,
                meta: z.record(z.string(), z.string()).optional(),
            },
        },
        ({ scope, kind, slug, title, desc, body, meta }) => {
            const sc = scope ?? opt.scope;
            const now = new Date().toISOString();
            return TEXT(
                call((s) => {
                    s.put({
                        scope: sc,
                        kind: kind as Kind,
                        slug,
                        title: title ?? slug,
                        desc: desc ?? '',
                        body,
                        meta: {
                            ...meta,
                            type: kind,
                            src: meta?.['src'] ?? 'claude',
                            created: meta?.['created'] ?? now,
                            updated: now,
                            order: meta?.['order'] ?? nextOrder(s, sc),
                        },
                        uses: 0,
                    });
                    return `已写入 /mem/${sc}/${kind}/${slug}/`;
                }),
            );
        },
    );

    server.registerTool(
        'mem_use',
        {
            title: '记一次引用',
            description: '记忆被引用时 uses +1，供衰减排序。',
            inputSchema: { slug: z.string(), scope: scopeArg, kind: kindArg },
        },
        ({ scope, kind, slug }) =>
            TEXT(
                call((s) => {
                    const n = s.use(scope ?? opt.scope, kind as Kind, slug);
                    return s.degraded ? 'uses 待回放（降级中）' : `uses=${n}`;
                }),
            ),
    );

    await server.connect(new StdioServerTransport());
}
