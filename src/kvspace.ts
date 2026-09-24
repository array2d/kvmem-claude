import koffi from 'koffi';

/** 对齐 kvspace.h 的 kvspaceHead_t；名字必须与 C 侧一致，供函数原型串引用。 */
const HEAD = koffi.struct('kvspaceHead_t', {
    headlen: 'uint16',
    ref: 'uint8',
    storetype: 'uint8',
    ro: 'uint8',
    vid: 'uint32',
    body_len: 'int32',
    ndim: 'int32',
    dims: 'int32[8]',
    langtype: 'char[256]',
    langtype_len: 'int32',
    body_offset: 'int32',
});

const lib = koffi.load(process.env.KVSPACE_LIB ?? 'libkvspace.so.1');

const fn = {
    connect: lib.func('void *kvspaceConnect(const char *dsn)'),
    close: lib.func('void kvspaceClose(void *h)'),
    get: lib.func('int kvspaceGet(void *h, const char *key, int resolve, _Out_ uint8_t **out, _Out_ uint32_t *out_len)'),
    writeNewPlace: lib.func('int kvspaceWriteNewPlace(void *h, const char *key, uint8_t ref, uint8_t storetype, uint8_t ro, uint32_t vid, const char *langtype, uint32_t body_len, _Out_ uint8_t **body, uint8_t *err, uint32_t err_cap)'),
    writeInPlace: lib.func('int kvspaceWriteInPlace(void *h, const char *key, int resolve, uint32_t body_len, _Out_ uint8_t **body, uint8_t *err, uint32_t err_cap)'),
    listLen: lib.func('int kvspaceListLen(void *h, const char *prefix, int expand_ext, int resolve, _Out_ int *out_count)'),
    listAt: lib.func('int kvspaceListAt(void *h, const char *prefix, int expand_ext, int resolve, int idx, _Out_ uint8_t *buf, uint32_t buf_cap, _Out_ uint32_t *out_len)'),
    del: lib.func('int kvspaceDel(void *h, const char **keys, uint32_t nkeys, uint8_t *err, uint32_t err_cap)'),
    delTree: lib.func('int kvspaceDelTree(void *h, const char *prefix, uint8_t *err, uint32_t err_cap)'),
    decodeHead: lib.func('kvspaceDecodeHead', 'int', [
        'const uint8_t *',
        'uint32_t',
        koffi.out(koffi.pointer(HEAD)),
    ]),
};

const REF_INLINE = 0;
export const STORETYPE_ATOM = 1;
export const STORETYPE_ARRAYND = 2;

const ERRBUF = Buffer.alloc(512);
ERRBUF.fill(0);

function errText(): string {
    const z = ERRBUF.indexOf(0);
    return ERRBUF.toString('utf8', 0, z < 0 ? ERRBUF.length : z);
}

function must(rc: number, what: string): void {
    if (rc !== 0) throw new Error(`kvspace ${what} 失败: ${errText()}`);
}

function borrowed(ptr: bigint | null, len: number): Buffer | null {
    if (ptr === null || ptr === 0n || len === 0) return null;
    return Buffer.from(koffi.decode(ptr, 'uint8', len));
}

export type Head = {
    langtype: string;
    storetype: number;
    ref: number;
    body_offset: number;
    body_len: number;
};

export function decodeHead(raw: Buffer): Head {
    const out: Record<string, unknown> = {};
    const rc = fn.decodeHead(raw, raw.length, out);
    must(rc, 'decodeHead');
    const lt = out.langtype as string;
    const z = lt.indexOf('\0');
    return {
        langtype: z < 0 ? lt : lt.slice(0, z),
        storetype: out.storetype as number,
        ref: out.ref as number,
        body_offset: out.body_offset as number,
        body_len: out.body_len as number,
    };
}

export type Value = { head: Head; body: Buffer };

/** 按 DSN 连一个后端。连接失败即抛，不回落。 */
export class KVSpace {
    #h: bigint;

    constructor(dsn: string) {
        const h = fn.connect(dsn) as bigint | null;
        if (h === null || h === 0n) throw new Error(`kvspace 连接失败：${dsn}`);
        this.#h = h;
    }

    close(): void {
        fn.close(this.#h);
    }

    get(key: string, resolve = true): Value | null {
        const out: [bigint | null] = [null];
        const len: [number] = [0];
        must(fn.get(this.#h, key, resolve ? 1 : 0, out, len), `get ${key}`);
        const raw = borrowed(out[0], len[0]);
        if (raw === null) return null;
        const head = decodeHead(raw);
        return { head, body: raw.subarray(head.body_offset, head.body_offset + head.body_len) };
    }

    putString(key: string, s: string): void {
        const body = Buffer.from(s, 'utf8');
        this.#write(key, STORETYPE_ARRAYND, `[${body.length}]char/utf8`, body);
    }

    putInt64(key: string, n: bigint): void {
        const body = Buffer.alloc(8);
        body.writeBigInt64LE(n);
        this.#write(key, STORETYPE_ATOM, 'int64', body);
    }

    /** 就地覆写同 kind 同长度的值；key 不存在或长度不符即抛。 */
    writeInPlace(key: string, body: Buffer): void {
        ERRBUF.fill(0);
        const out: [bigint | null] = [null];
        must(fn.writeInPlace(this.#h, key, 1, body.length, out, ERRBUF, ERRBUF.length), `writeInPlace ${key}`);
        if (out[0] === null) throw new Error(`kvspace writeInPlace ${key} 返回空 body`);
        koffi.encode(out[0], 'uint8', body, body.length);
    }

    #write(key: string, storetype: number, langtype: string, body: Buffer): void {
        ERRBUF.fill(0);
        const out: [bigint | null] = [null];
        must(fn.writeNewPlace(this.#h, key, REF_INLINE, storetype, 0, 0, langtype, body.length, out, ERRBUF, ERRBUF.length), `write ${key}`);
        if (out[0] === null) throw new Error(`kvspace write ${key} 返回空 body`);
        koffi.encode(out[0], 'uint8', body, body.length);
    }

    /** 前缀下的直接子项名；目录项带尾 `/`。 */
    list(prefix: string): string[] {
        const cnt: [number] = [0];
        must(fn.listLen(this.#h, prefix, 0, 1, cnt), `listLen ${prefix}`);
        const names: string[] = [];
        for (let i = 0; i < cnt[0]; i++) {
            const buf = Buffer.alloc(4096);
            const len: [number] = [0];
            must(fn.listAt(this.#h, prefix, 0, 1, i, buf, buf.length, len), `listAt ${prefix}[${i}]`);
            names.push(buf.toString('utf8', 0, len[0]));
        }
        return names;
    }

    del(keys: string[]): void {
        if (keys.length === 0) return;
        ERRBUF.fill(0);
        must(fn.del(this.#h, keys, keys.length, ERRBUF, ERRBUF.length), `del ${keys.join(',')}`);
    }

    delTree(prefix: string): void {
        ERRBUF.fill(0);
        must(fn.delTree(this.#h, prefix, ERRBUF, ERRBUF.length), `delTree ${prefix}`);
    }
}
