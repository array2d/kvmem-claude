#!/usr/bin/env node
/**
 * 端到端验收（issue #1 的验收条款逐条落成断言）。
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
const MEM = path.join(HOME, 'projects', PROJ.replace(/[/.]/g, '-'), 'memory');
const SCOPE = PROJ.replace(/[/.]/g, '-');

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

function writeMemory(slug: string, kind: string, name: string, desc: string, body: string, line?: number): void {
    const meta = ['metadata:', '  node_type: memory', `  type: ${kind}`, '  originSessionId: e2e', '  modified: 2026-01-01T00:00:00.000Z'];
    fs.writeFileSync(
        path.join(MEM, `${slug}.md`),
        `---\nname: ${name}\ndescription: ${desc}\n${meta.join('\n')}\n---\n\n${body}\n`,
    );
    void line;
}

try {
    fs.mkdirSync(MEM, { recursive: true });
    spawnSync(KVSPACE_BIN, ['deltree', `/mem/${SCOPE}/`], { env: { ...process.env, KVSPACE: DSN } });

    writeMemory('alpha', 'project', 'alpha', 'alpha desc', 'alpha body');
    writeMemory('beta', 'feedback', 'beta', 'beta desc', 'beta body');
    writeMemory('gamma', 'project', 'gamma', 'gamma desc', 'gamma body');
    // gamma 故意不进索引——索引缺项就是"记忆不可见"，重建索引时必须把它捞回来
    fs.writeFileSync(path.join(MEM, 'MEMORY.md'), '- [Alpha](alpha.md) — alpha desc\n- [Beta](beta.md) — beta desc\n');

    // ① 只读导入：本地零改动
    const before = fs.readFileSync(path.join(MEM, 'alpha.md'), 'utf8');
    const imported = must(['import', '--project', PROJ]);
    assert.match(imported, /alpha: → kvspace/);
    assert.equal(fs.readFileSync(path.join(MEM, 'alpha.md'), 'utf8'), before, 'import 不得改本地文件');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/title`), 'char/utf8:Alpha');
    assert.equal(raw(`/mem/${SCOPE}/feedback/beta/meta/type`), 'char/utf8:feedback');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/body`), 'char/utf8:alpha body');
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/meta/uses`), 'int64:0');
    ok('① 只读导入：三条记忆进 kvspace，本地文件逐字未动');

    // ② MEMORY.md 是 kvspace 的投影：索引缺项被找回，顺序照旧
    assert.equal(
        must(['ls', `${SCOPE}/`]),
        '- [Alpha](alpha.md) — alpha desc\n- [Beta](beta.md) — beta desc\n- [gamma](gamma.md) — gamma desc\n',
    );
    ok('② ls 逐字重现 MEMORY.md，并把漏索引的 gamma 补在末尾');

    // ③ 本地改动 → 同步进 kvspace
    fs.writeFileSync(path.join(MEM, 'alpha.md'), before.replace('alpha body', 'alpha body v2'));
    assert.match(must(['import', '--project', PROJ]), /alpha: → kvspace/);
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/body`), 'char/utf8:alpha body v2');
    ok('③ 本地改动后 import，kvspace 读到新正文');

    // ④ 两侧都改 → 冲突，绝不静默覆盖
    must(['put', `${SCOPE}/project/alpha`, '--title', 'Alpha', '--desc', 'alpha desc', '--body-file', '-'], {
        input: 'alpha body from kvspace',
    });
    const conflict = kvmem(['import', '--project', PROJ]);
    assert.equal(conflict.rc, 1, '冲突必须非零退出');
    assert.match(conflict.err, /冲突/);
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/body`), 'char/utf8:alpha body from kvspace', '冲突时不得写');
    ok('④ 本地与 kvspace 都改过 → import 报冲突并拒绝写入');

    // ⑤ 显式裁决：kvspace 覆盖本地
    must(['export', '--project', PROJ, '--prefer', 'remote']);
    assert.equal(fs.readFileSync(path.join(MEM, 'alpha.md'), 'utf8').includes('alpha body from kvspace'), true);
    ok('⑤ export --prefer remote：本地文件被 kvspace 版本覆盖');

    // ⑥ 反向：本地改动 → kvspace（sync 走 pull 方向）
    must(['put', `${SCOPE}/project/gamma`, '--title', 'Gamma', '--desc', 'gamma desc', '--body-file', '-'], {
        input: 'gamma body from kvspace',
    });
    const pulled = must(['sync', '--project', PROJ]);
    assert.match(pulled, /gamma: ← kvspace/);
    assert.equal(fs.readFileSync(path.join(MEM, 'gamma.md'), 'utf8').includes('gamma body from kvspace'), true);
    ok('⑥ sync：kvspace 的改动落回本地 .md');

    // ⑦ 删除传播：本地删文件 → kvspace 侧同步删除
    fs.rmSync(path.join(MEM, 'beta.md'));
    assert.match(must(['sync', '--project', PROJ]), /beta: × 删除 kvspace/);
    assert.equal(raw(`/mem/${SCOPE}/feedback/beta/title`), null);
    ok('⑦ 删除传播：本地删掉 beta.md，kvspace 条目随之消失');

    // ⑧ MEMORY.md 可完整重建
    fs.rmSync(path.join(MEM, 'MEMORY.md'));
    must(['sync', '--project', PROJ]);
    const rebuilt = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8');
    assert.equal(rebuilt, must(['ls', `${SCOPE}/`]));
    assert.match(rebuilt, /- \[Alpha\]\(alpha\.md\) — alpha desc/);
    ok('⑧ 删掉 MEMORY.md 后由 kvspace 完整重建，与 ls 逐字相同');

    // ⑨ 后端不可用：读降级本地、写进 pending、重连后回放
    const dead = kvmem(['ls', `${SCOPE}/`], { dsn: DEAD_DSN });
    assert.equal(dead.rc, 0, `后端不可用时 ls 必须不报错：${dead.err}`);
    assert.match(dead.err, /降级/);
    assert.match(dead.out, /\[Alpha\]\(alpha\.md\)/);
    const deadPut = kvmem(['put', `${SCOPE}/project/delta`, '--title', 'Delta', '--desc', 'd', '--body-file', '-'], {
        dsn: DEAD_DSN,
        input: 'delta body',
    });
    assert.equal(deadPut.rc, 0, deadPut.err);
    assert.equal(fs.existsSync(path.join(HOME, '.kvmem', 'pending.jsonl')), true, '降级写入必须落 pending 日志');
    assert.equal(raw(`/mem/${SCOPE}/project/delta/title`), null, '降级期间 kvspace 未写入');
    must(['ls', `${SCOPE}/`]);
    assert.equal(raw(`/mem/${SCOPE}/project/delta/title`), 'char/utf8:Delta', '重连后必须回放 pending 写操作');
    assert.equal(fs.existsSync(path.join(HOME, '.kvmem', 'pending.jsonl')), false, '回放成功后清空日志');
    assert.equal(raw(`/mem/${SCOPE}/project/delta/body`), 'char/utf8:delta body');
    ok('⑨ 后端不可用时读本地不报错、写进 pending，重连后回放且不丢');

    // ⑩ 无本地记忆目录时，降级不成立——必须报错而不是返回空
    const elsewhere = path.join(ROOT, 'nowhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const dry = kvmem(['ls', `${elsewhere.replace(/[/.]/g, '-')}/`], { dsn: DEAD_DSN });
    assert.equal(dry.rc, 1);
    assert.match(dry.err, /记忆目录不存在/);
    ok('⑩ 后端不可用且无本地目录时报错，不静默返回空');

    // ⑪ uses 计数
    assert.match(must(['use', `${SCOPE}/project/alpha`]), /uses=1/);
    assert.match(must(['use', `${SCOPE}/project/alpha`]), /uses=2/);
    assert.equal(raw(`/mem/${SCOPE}/project/alpha/meta/uses`), 'int64:2');
    ok('⑪ use 累加 meta/uses（int64 就地写）');

    // ⑫ MCP server：五个工具就是记忆面五个动作
    const rpc = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mem_ls', arguments: { scope: SCOPE } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mem_search', arguments: { scope: SCOPE, query: 'alpha' } } },
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
    const tools = (byId.get(2)?.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(tools, ['mem_get', 'mem_ls', 'mem_put', 'mem_search', 'mem_use'], mcp.stderr);
    assert.match(byId.get(3)?.result?.content?.[0]?.text ?? '', /- \[Alpha\]\(alpha\.md\) — alpha desc/);
    assert.match(byId.get(4)?.result?.content?.[0]?.text ?? '', /alpha\.md/);
    ok('⑫ MCP server 暴露五个工具，mem_ls / mem_search 返回值正确');

    process.stdout.write(`\n${passed} 项验收通过（临时目录 ${ROOT}）\n`);
} finally {
    spawnSync(KVSPACE_BIN, ['deltree', `/mem/${SCOPE}/`], { env: { ...process.env, KVSPACE: DSN } });
    if (process.env['KVMEM_E2E_KEEP'] !== '1') fs.rmSync(ROOT, { recursive: true, force: true });
}
