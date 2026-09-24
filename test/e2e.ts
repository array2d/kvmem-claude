#!/usr/bin/env node
/**
 * 端到端验收：issue #1 的验收条款，加上「kvspace 是唯一存储、本地只是投影」这条重构。
 *
 * 全程在临时 CLAUDE_CONFIG_DIR 里跑，kvspace 只动自己的临时 scope，不碰真实记忆与真实 scope。
 * kvspace 侧的断言一律用独立的 `kvspace` CLI 取，避免用被测代码自己证明自己。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const KVSPACE_BIN = '/usr/bin/kvspace';
const DSN = process.env['KVSPACE'] ?? 'redis://127.0.0.1:6379';
const DEAD_DSN = 'redis://127.0.0.1:1';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kvmem-e2e-'));
const HOME = path.join(ROOT, 'claude');
const PROJ = path.join(ROOT, 'proj');
const SCOPE = PROJ.replace(/[/.]/g, '-');
const SLUG_SCOPE = `${SCOPE}-slug`;
const MIGRATE_SCOPE = `${SCOPE}-mig`;

/** 投影目录按 scope 名定位（与 Claude Code 的项目 slug 同构）。 */
function memDir(scope: string): string {
    return path.join(HOME, 'projects', scope, 'memory');
}

let passed = 0;
function ok(name: string): void {
    passed += 1;
    process.stdout.write(`✓ ${name}\n`);
}

function kvmem(args: string[], o: { dsn?: string; input?: string } = {}): { rc: number; out: string; err: string } {
    const r = spawnSync('node', [CLI, ...args], {
        encoding: 'utf8',
        input: o.input ?? '',
        env: { ...process.env, CLAUDE_CONFIG_DIR: HOME, KVSPACE: o.dsn ?? DSN },
    });
    return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function must(args: string[], o: { dsn?: string; input?: string } = {}): string {
    const r = kvmem(args, o);
    assert.equal(r.rc, 0, `${args.join(' ')} 应成功，实际 rc=${r.rc}\n${r.err}${r.out}`);
    return r.out;
}

/** 独立 oracle：直接用 kvspace CLI 取原始 XValue。 */
function raw(key: string): string | null {
    const r = spawnSync(KVSPACE_BIN, ['get', key], { encoding: 'utf8', env: { ...process.env, KVSPACE: DSN } });
    const v = (r.stdout.split('\t')[1] ?? '').trim();
    return v === '(nil)' ? null : v;
}

function writeLocalMem(scope: string, slug: string, kind: string, desc: string, body: string): void {
    fs.mkdirSync(memDir(scope), { recursive: true });
    fs.writeFileSync(
        path.join(memDir(scope), `${slug}.md`),
        `---\nname: ${slug}\ndescription: ${desc}\nmetadata:\n  node_type: memory\n` +
            `  type: ${kind}\n  originSessionId: e2e\n  modified: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`,
    );
}

function put(scope: string, kind: string, slug: string, title: string, desc: string, body: string): void {
    must(['put', `${scope}/${kind}/${slug}`, '--title', title, '--desc', desc, '--body-file', '-'], { input: body });
}

const SCOPES = [SCOPE, SLUG_SCOPE, MIGRATE_SCOPE];

try {
    for (const s of SCOPES) spawnSync(KVSPACE_BIN, ['deltree', `/mem/${s}/`], { env: { ...process.env, KVSPACE: DSN } });

    // ① kvspace 是唯一存储：没有本地记忆目录也能写、能读
    put(SCOPE, 'project', 'alpha', 'Alpha', 'alpha desc', 'alpha body');
    put(SCOPE, 'feedback', 'beta', 'Beta', 'beta desc', 'beta body');
    assert.equal(fs.existsSync(memDir(SCOPE)), false, '写记忆不得凭空造出本地目录');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/title`), 'char/utf8:Alpha');
    assert.equal(raw(`/mem/${SCOPE}/feedback/beta/meta/type`), 'char/utf8:feedback');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/body`), 'char/utf8:alpha body');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/meta/uses`), 'int64:0');
    assert.match(must(['get', `${SCOPE}/project/alpha`]), /alpha body/);
    assert.match(must(['search', `${SCOPE}/`, 'beta']), /beta\.md/);
    assert.equal(must(['ls', `${SCOPE}/`]), '- [Alpha](alpha.md) — alpha desc\n- [Beta](beta.md) — beta desc\n');
    ok('① 无需任何本地目录：put/get/ls/search 直接落在 kvspace');

    // ② slug 只禁 `/` 与 `·`，其余一律放行
    for (const bad of ['a/b', 'a·b']) {
        const r = kvmem(['put', `${SLUG_SCOPE}/project/${bad}`, '--body-file', '-'], { input: 'x' });
        assert.equal(r.rc, 1, `${bad} 必须被拒`);
        assert.match(r.err, /非法 slug|记忆路径必须是/);
    }
    const odd = ['中文-slug', 'UPPER', 'dot.name', 'a)b', 'with space', '..'];
    for (const slug of odd) {
        put(SLUG_SCOPE, 'project', slug, `T${slug}`, 'd', `body ${slug}`);
        assert.equal(raw(`/mem/${SLUG_SCOPE}/project/${slug}/body`), `char/utf8:body ${slug}`, `${slug} 应可原样存取`);
        assert.match(must(['get', `${SLUG_SCOPE}/project/${slug}`]), new RegExp(`body ${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    assert.match(must(['ls', `${SLUG_SCOPE}/`]), /dot\.name\.md/);
    ok(`② slug 只禁 / 与 ·：${odd.length} 种其它写法全通，2 种被拒`);

    // ③ 一次性迁移：本地已有 .md 单向搬进 kvspace
    writeLocalMem(MIGRATE_SCOPE, 'one', 'project', 'one desc', 'one body');
    writeLocalMem(MIGRATE_SCOPE, 'two', 'feedback', 'two desc', 'two body');
    writeLocalMem(MIGRATE_SCOPE, 'hidden', 'reference', 'hidden desc', 'hidden body');
    // 索引里有标题行、且漏掉了 hidden——两者都不该让迁移失败
    fs.writeFileSync(path.join(memDir(MIGRATE_SCOPE), 'MEMORY.md'), '# Memory Index\n\n- [One](one.md) — one desc\n- [Two](two.md) — two desc\n');
    const oneBefore = fs.readFileSync(path.join(memDir(MIGRATE_SCOPE), 'one.md'), 'utf8');
    must(['import', '--scope', MIGRATE_SCOPE]);
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/project/one/title`), 'char/utf8:One');
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/project/one/meta/order`), 'char/utf8:0');
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/feedback/two/meta/order`), 'char/utf8:1');
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/reference/hidden/body`), 'char/utf8:hidden body');
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/reference/hidden/meta/order`), null, '不在索引里的记忆不编造 order');
    assert.equal(fs.readFileSync(path.join(memDir(MIGRATE_SCOPE), 'one.md'), 'utf8'), oneBefore, 'import 不得改本地文件');

    // 迁移是种子不是同步：kvspace 已有的默认跳过，本地旧内容无资格覆盖真相
    fs.writeFileSync(path.join(memDir(MIGRATE_SCOPE), 'one.md'), oneBefore.replace('one body', '本地改过的 body'));
    assert.match(must(['import', '--scope', MIGRATE_SCOPE]), /one: = kvspace 已有，跳过/);
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/project/one/body`), 'char/utf8:one body', '默认不得被本地覆盖');
    must(['import', '--scope', MIGRATE_SCOPE, '--force']);
    assert.equal(raw(`/mem/${MIGRATE_SCOPE}/project/one/body`), 'char/utf8:本地改过的 body', '--force 才覆盖');
    ok('③ import 单向迁移：已有默认跳过，--force 才覆盖；索引缺项/标题行都不影响');

    // ④ render：kvspace → 本地投影，单向且可重复
    must(['render', '--scope', SCOPE]);
    assert.equal(
        fs.readFileSync(path.join(memDir(SCOPE), 'MEMORY.md'), 'utf8'),
        must(['ls', `${SCOPE}/`]),
        'MEMORY.md 必须与 ls 逐字一致',
    );
    assert.match(fs.readFileSync(path.join(memDir(SCOPE), 'alpha.md'), 'utf8'), /name: alpha/);
    fs.writeFileSync(path.join(memDir(SCOPE), 'alpha.md'), '本地把投影写坏了');
    fs.writeFileSync(path.join(memDir(SCOPE), 'bogus.md'), 'kvspace 里没有这条\n');
    fs.rmSync(path.join(memDir(SCOPE), 'MEMORY.md'));
    assert.match(must(['render', '--scope', SCOPE]), /bogus: × 删除投影/);
    assert.equal(fs.existsSync(path.join(memDir(SCOPE), 'bogus.md')), false, '野文件必须被清掉');
    assert.match(fs.readFileSync(path.join(memDir(SCOPE), 'alpha.md'), 'utf8'), /alpha body/, '投影被写坏后 render 应还原');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/body`), 'char/utf8:alpha body', 'render 不得改 kvspace');
    assert.equal(fs.readFileSync(path.join(memDir(SCOPE), 'MEMORY.md'), 'utf8'), must(['ls', `${SCOPE}/`]));
    ok('④ render 单向重建投影：改坏/删掉/多出来的本地文件都会被 kvspace 复原或清掉');

    // ⑤ 后端不可用：读降级到投影，不报错
    const dead = kvmem(['ls', `${SCOPE}/`], { dsn: DEAD_DSN });
    assert.equal(dead.rc, 0, `后端不可用时 ls 必须不报错：${dead.err}`);
    assert.match(dead.err, /降级/);
    assert.match(dead.out, /\[Alpha\]\(alpha\.md\)/);
    assert.match(must(['get', `${SCOPE}/feedback/beta`], { dsn: DEAD_DSN }), /beta body/);
    assert.match(must(['search', `${SCOPE}/`, 'alpha'], { dsn: DEAD_DSN }), /alpha\.md/);
    ok('⑤ 后端不可用时读投影：ls / get / search 都不报错');

    // ⑥ 后端不可用：写进 pending，重连回放
    const deadPut = kvmem(['put', `${SCOPE}/project/delta`, '--title', 'Delta', '--desc', 'd', '--body-file', '-'], {
        dsn: DEAD_DSN,
        input: 'delta body',
    });
    assert.equal(deadPut.rc, 0, deadPut.err);
    assert.equal(fs.existsSync(path.join(HOME, '.kvmem', 'pending.jsonl')), true, '降级写入必须落 pending 日志');
    assert.equal(raw(`/mem/${SCOPE}/project/delta/title`), null, '降级期间 kvspace 未写入');
    must(['ls', `${SCOPE}/`]);
    assert.equal(raw(`/mem/${SCOPE}/project/delta/title`), 'char/utf8:Delta', '重连后必须回放 pending 写操作');
    assert.equal(raw(`/mem/${SCOPE}/project/delta/body`), 'char/utf8:delta body');
    assert.equal(fs.existsSync(path.join(HOME, '.kvmem', 'pending.jsonl')), false, '回放成功后清空日志');
    ok('⑥ 后端不可用时写进 pending，重连后回放且不丢');

    // ⑦ 既没有投影、后端又不可用：报错，不返回空
    assert.equal(raw(`/mem/${SCOPE}-nowhere/project/x/title`), null);
    const dry = kvmem(['ls', `${SCOPE}-nowhere/`], { dsn: DEAD_DSN });
    assert.equal(dry.rc, 1);
    assert.match(dry.err, /记忆目录不存在/);
    ok('⑦ 没有投影可降级时报错，不静默返回空');

    // ⑧ uses 计数
    assert.match(must(['use', `${SCOPE}/project/alpha`]), /uses=1/);
    assert.match(must(['use', `${SCOPE}/project/alpha`]), /uses=2/);
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/meta/uses`), 'int64:2');
    ok('⑧ use 累加 meta/uses（int64 就地写）');

    // ⑨ MCP server：五个工具就是记忆面五个动作
    const rpc = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mem_ls', arguments: { scope: SCOPE } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mem_put', arguments: { scope: SLUG_SCOPE, kind: 'project', slug: 'mcp-written', title: 'M', body: 'mcp body' } } },
    ];
    const mcp = spawnSync('node', [CLI, 'mcp', '--scope', SCOPE], {
        encoding: 'utf8',
        input: `${rpc.map((m) => JSON.stringify(m)).join('\n')}\n`,
        env: { ...process.env, CLAUDE_CONFIG_DIR: HOME, KVSPACE: DSN },
    });
    const replies = mcp.stdout
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[]; content?: { text: string }[] }; error?: unknown });
    const byId = new Map(replies.map((r) => [r.id, r]));
    assert.deepEqual(
        (byId.get(2)?.result?.tools ?? []).map((t) => t.name).sort(),
        ['mem_get', 'mem_ls', 'mem_put', 'mem_search', 'mem_use'],
        mcp.stderr,
    );
    assert.match(byId.get(3)?.result?.content?.[0]?.text ?? '', /- \[Alpha\]\(alpha\.md\) — alpha desc/);
    assert.equal(raw(`/mem/${SLUG_SCOPE}/project/mcp-written/body`), 'char/utf8:mcp body', 'MCP 写入同样只落 kvspace');
    ok('⑨ MCP 暴露五个工具，mem_ls / mem_put 直接读写 kvspace');

    // ⑩ status
    const st = must(['status', '--scope', SCOPE]);
    assert.match(st, /kvspace 记忆   3（唯一存储）/);
    assert.match(st, /本地投影/);
    ok('⑩ status 报出 kvspace 记忆数与本地投影位置');

    process.stdout.write(`\n${passed} 项验收通过（临时目录 ${ROOT}）\n`);
} finally {
    for (const s of SCOPES) spawnSync(KVSPACE_BIN, ['deltree', `/mem/${s}/`], { env: { ...process.env, KVSPACE: DSN } });
    if (process.env['KVMEM_E2E_KEEP'] !== '1') fs.rmSync(ROOT, { recursive: true, force: true });
}
