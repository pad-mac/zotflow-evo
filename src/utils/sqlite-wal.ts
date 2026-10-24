/**
 * ZotFlow Evo (fork): a SQLite database file brought up to date with its
 * write-ahead log, as SQLite itself reads the two together. Zotero keeps
 * `zotero.sqlite` and `fulltext.sqlite` in WAL mode while it runs and
 * writes changes back into the files only now and then (and when it
 * closes), so the files alone miss what changed since — the full-text
 * search reads copies of both (src/fulltext/worker.ts). Pure, no I/O.
 *
 * The format: https://www.sqlite.org/fileformat2.html#walformat. A 32-byte
 * header (magic, version, page size, checkpoint number, two salts, a
 * checksum), then frames: a 24-byte header (page number, the database's
 * size in pages after a commit or 0, the salts, a running checksum) and
 * one page. Frames count while their salts are the header's and the
 * running checksum holds; of those, the ones up to the last commit.
 */

const HEADER = 32;
const FRAME_HEADER = 24;
const MAGIC = 0x377f0682;

/** The running checksum over `bytes` (a multiple of 8 long). */
function checksum(
    bytes: Uint8Array,
    bigEndian: boolean,
    s0: number,
    s1: number,
): [number, number] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 8 <= bytes.byteLength; i += 8) {
        s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
        s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
    }
    return [s0, s1];
}

export interface WalResult {
    /** The database as of the log's last commit (the input itself when the log adds nothing). */
    database: Uint8Array;
    /** Pages the log replaced or added. */
    pages: number;
}

/**
 * `database` with the committed frames of `wal` written into it. A log
 * that does not belong to it (another page size), is empty, damaged or
 * left over from before the last checkpoint adds nothing. The input is
 * changed in place when the database does not grow.
 */
export function applyWal(database: Uint8Array, wal: Uint8Array | null): WalResult {
    const none = { database, pages: 0 };
    if (!wal || wal.byteLength < HEADER) return none;
    const head = new DataView(wal.buffer, wal.byteOffset, HEADER);
    const magic = head.getUint32(0);
    if ((magic & 0xfffffffe) !== MAGIC) return none;
    const bigEndian = (magic & 1) === 1;
    const pageSize = head.getUint32(8);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
        return none;
    // The database's own page size (bytes 16-17; 1 means 65536).
    if (database.byteLength >= 100) {
        const raw = (database[16]! << 8) | database[17]!;
        const own = raw === 1 ? 65536 : raw;
        if (own !== pageSize) return none;
    }
    const salt1 = head.getUint32(16);
    const salt2 = head.getUint32(20);
    let [s0, s1] = checksum(wal.subarray(0, 24), bigEndian, 0, 0);
    if (s0 !== head.getUint32(24) || s1 !== head.getUint32(28)) return none;

    // Page number → offset of its latest committed copy in the log.
    const committed = new Map<number, number>();
    const pending = new Map<number, number>();
    let size = 0;
    const frameSize = FRAME_HEADER + pageSize;
    for (let at = HEADER; at + frameSize <= wal.byteLength; at += frameSize) {
        const frame = new DataView(wal.buffer, wal.byteOffset + at, FRAME_HEADER);
        if (frame.getUint32(8) !== salt1 || frame.getUint32(12) !== salt2) break;
        [s0, s1] = checksum(wal.subarray(at, at + 8), bigEndian, s0, s1);
        [s0, s1] = checksum(
            wal.subarray(at + FRAME_HEADER, at + frameSize),
            bigEndian,
            s0,
            s1,
        );
        if (s0 !== frame.getUint32(16) || s1 !== frame.getUint32(20)) break;
        const page = frame.getUint32(0);
        if (page === 0) break;
        pending.set(page, at + FRAME_HEADER);
        const commit = frame.getUint32(4);
        if (commit > 0) {
            for (const [p, offset] of pending) committed.set(p, offset);
            pending.clear();
            size = commit;
        }
    }
    if (size === 0) return none;

    const length = size * pageSize;
    let out = database;
    if (length > database.byteLength) {
        out = new Uint8Array(length);
        out.set(database);
    } else if (length < database.byteLength) {
        out = database.subarray(0, length);
    }
    let pages = 0;
    for (const [page, offset] of committed) {
        if (page > size) continue;
        out.set(wal.subarray(offset, offset + pageSize), (page - 1) * pageSize);
        pages++;
    }
    return { database: out, pages };
}
