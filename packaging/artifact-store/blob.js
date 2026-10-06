/**
 * Content-addressed blob storage.
 *
 * Immutable and ACL-free by construction: a blob is bytes plus their intrinsic
 * properties. Everything that varies per user of those bytes lives in the
 * reference store.
 *
 * @module @adaptive-compact/dsh-artifact-store/blob
 */
// node:buffer isUtf8 checks stored bytes before decoding.
import { isUtf8 as nodeIsUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { join } from 'node:path';
import { ArtifactError } from "./errors.js";
/**
 * How long a temp file must sit untouched before a sweep may reclaim it.
 *
 * Anything younger may belong to a write in flight in another process, and
 * unlinking it would make that healthy writer fail at rename. An hour is far
 * beyond any single synchronous write and far below the scale at which leaked
 * files matter. Exported so the store's follow-up sweep schedules against the
 * same number rather than a second copy that can drift.
 */
export const TEMP_SWEEP_MARGIN_MS = 3_600_000;
/**
 * Unlink without ever throwing.
 *
 * Every caller is already on a failure path and about to raise a stable
 * `ARTIFACT_WRITE_FAILED`. If the same storage fault that broke the write also
 * breaks the cleanup, a throwing unlink would REPLACE that error with a raw
 * filesystem exception — callers matching on the store's error codes would
 * stop recognising it, and the original cause would be lost entirely.
 * Leaking one temp is the lesser harm, and the sweep reclaims it later.
 */
function unlinkQuietly(path) {
    try {
        rmSync(path, { force: true });
    }
    catch {
        // Deliberately swallowed: see above.
    }
}
export function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
/** Split text into lines, dropping the empty element a trailing newline leaves. */
export function splitLines(text) {
    if (text.length === 0)
        return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return lines;
}
/** Count lines the way a reader does: a trailing newline does not add one. */
export function countLines(text) {
    return splitLines(text).length;
}
/**
 * Whether the bytes round-trip through UTF-8 unchanged.
 *
 * Delegates to `node:buffer`'s own native check rather than the equivalent
 * `Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0`
 * — decoding and re-encoding the whole buffer to prove a negative costs real
 * time proportional to its size (measured: ~15ms for a 1 MB non-UTF-8 buffer,
 * against node:buffer's ~0.02ms for the same input — found chasing PERF-09,
 * where this was called twice per `putSync`, once here and once more inline
 * in `sniffMime`'s caller below, together accounting for most of a 1 MB
 * write's latency). Same result for both, since both answer the identical
 * question; only the cost differs.
 */
export function isUtf8(buffer) {
    return nodeIsUtf8(buffer);
}
function sniffMime(buffer, utf8) {
    if (!utf8)
        return 'application/octet-stream';
    const head = buffer.subarray(0, 512).toString('utf8').trimStart();
    if (head.startsWith('{') || head.startsWith('['))
        return 'application/json';
    return 'text/plain';
}
export class BlobStore {
    root;
    durability;
    constructor(root, durability) {
        this.root = root;
        this.durability = durability;
    }
    dirFor(digest) {
        return join(this.root, 'sha256', digest.slice(0, 2));
    }
    binPath(digest) {
        return join(this.dirFor(digest), `${digest}.bin`);
    }
    infoPath(digest) {
        return join(this.dirFor(digest), `${digest}.info.json`);
    }
    has(digest) {
        return existsSync(this.binPath(digest));
    }
    info(digest) {
        try {
            return JSON.parse(readFileSync(this.infoPath(digest), 'utf8'));
        }
        catch {
            return undefined;
        }
    }
    /**
     * Store bytes synchronously.
     *
     * Synchronous by requirement, not preference: the upstream
     * `ToolResultPruner.pruneSession()` is synchronous and appends the shadow
     * price and its replacement adjacently, so an artifact write that yielded
     * would have to break that contract.
     *
     * Under `fsync` the order is write → fsync(fd) → rename → fsync(dir).
     * Syncing only the directory would persist the rename while leaving the
     * file's contents unwritten — a log entry pointing at bytes that are not
     * there, which is precisely the failure this ordering exists to prevent.
     *
     * @param body - exact bytes to store.
     * @param hints - optional overrides for sniffed properties.
     * @returns the blob's intrinsic properties.
     */
    putSync(body, hints, 
    /** Digest of `body`, when the caller already computed it. */
    knownDigest) {
        const digest = knownDigest ?? sha256(body);
        // One read answers both "is it recorded" and "what is it": the previous
        // info() + has() pair cost an extra existsSync on every write.
        const existing = this.info(digest);
        if (existing !== undefined && this.has(digest))
            return { info: existing, deduplicated: true };
        // Validity first, decode only once that is settled: isUtf8's own native
        // check is cheap (see its own doc), so a body that turns out to be
        // binary now costs nothing here — no decode, no round-trip comparison —
        // instead of always decoding first and then discarding the result.
        // countLines still needs the decoded string, so this pays for exactly
        // one decode, and only for content already known to be valid UTF-8.
        const utf8 = hints?.encoding === undefined ? isUtf8(body) : hints.encoding === 'utf-8';
        const decoded = utf8 ? body.toString('utf8') : undefined;
        const info = {
            sha256: digest,
            byteLength: body.byteLength,
            lineCount: decoded !== undefined ? countLines(decoded) : 0,
            mime: hints?.mime ?? sniffMime(body, utf8),
            encoding: utf8 ? 'utf-8' : 'binary',
            ...(hints?.language === undefined ? {} : { language: hints.language }),
        };
        const dir = this.dirFor(digest);
        mkdirSync(dir, { recursive: true });
        // A per-write random suffix, not an identity-derived one.
        //
        // Two earlier revisions tried to derive uniqueness from the writer's
        // identity and each missed a case: `process.pid` alone collides between
        // worker_threads (same pid, different threadId), and pid+threadId still
        // collides across PID NAMESPACES — two containers mounting the same volume
        // both see a main thread at some namespace-local pid with threadId 0. PIDs
        // are simply not filesystem-global, so no combination of them is a safe
        // basis for a name on shared storage.
        //
        // randomUUID sidesteps the whole category: it is unique per CALL, so two
        // writers cannot collide regardless of how their identities compare. ST-04
        // races separate processes in one namespace and so cannot observe either
        // of the missed cases — both are closed by construction here.
        const tmp = join(dir, `.${digest}.${randomUUID()}.tmp`);
        let fd;
        try {
            fd = openSync(tmp, 'w');
            writeSync(fd, body);
            if (this.durability === 'fsync')
                fsyncSync(fd);
        }
        catch (error) {
            // Unlink before rethrowing. With an identity-derived temp name a retry
            // would have reused (and so overwritten) this path, but a per-call
            // randomUUID never repeats: every failed write would otherwise strand a
            // full artifact-sized hidden file forever. Repeated transient storage
            // failures would accumulate them without bound.
            unlinkQuietly(tmp);
            throw new ArtifactError('ARTIFACT_WRITE_FAILED', `writing ${digest}`, { cause: error });
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
        }
        try {
            // rename is atomic within a filesystem, so a reader never sees a partial file.
            renameSync(tmp, this.binPath(digest));
        }
        catch (error) {
            unlinkQuietly(tmp);
            throw new ArtifactError('ARTIFACT_WRITE_FAILED', `publishing ${digest}`, { cause: error });
        }
        this.writeInfo(dir, digest, info);
        if (this.durability === 'fsync')
            this.syncDir(dir);
        return { info, deduplicated: false };
    }
    /**
     * Publish the metadata file atomically.
     *
     * The blob's bytes are identical for a given digest by construction, but its
     * INFO is not: two writers can supply different valid hints (one passing
     * `language`, one not), producing JSON of different lengths. A bare
     * `writeFileSync` on the shared path lets a shorter write land inside a
     * longer one, leaving a valid prefix followed by the other writer's tail —
     * unparseable, so `info()` returns undefined and the artifact becomes
     * unusable through every metadata-dependent API even though its bytes are
     * perfectly intact. Temp-then-rename gives the metadata the same atomicity
     * the blob already has: a reader sees one writer's complete JSON or the
     * other's, never a splice.
     *
     * ST-04 cannot surface this — every child there passes identical hints, so
     * every candidate write is byte-identical and any interleaving looks clean.
     */
    writeInfo(dir, digest, info) {
        const tmp = join(dir, `.${digest}.${randomUUID()}.info.tmp`);
        try {
            writeFileSync(tmp, JSON.stringify(info));
            renameSync(tmp, this.infoPath(digest));
        }
        catch (error) {
            unlinkQuietly(tmp);
            throw new ArtifactError('ARTIFACT_WRITE_FAILED', `writing info for ${digest}`, { cause: error });
        }
    }
    syncDir(dir) {
        let fd;
        try {
            fd = openSync(dir, 'r');
            fsyncSync(fd);
        }
        catch {
            // Directory fsync is unsupported on some filesystems; the file's own
            // fsync already happened, which is the part that carries the content.
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
        }
    }
    /**
     * Read the stored bytes, verifying them against their digest.
     * @param digest - the content digest.
     * @returns the exact stored bytes.
     * @throws ARTIFACT_MISSING or ARTIFACT_CORRUPT.
     */
    read(digest) {
        let body;
        try {
            body = readFileSync(this.binPath(digest));
        }
        catch (error) {
            throw new ArtifactError('ARTIFACT_MISSING', `no blob for ${digest}`, { cause: error });
        }
        // Content addressing is only a guarantee if it is checked. Silent bit rot
        // would otherwise flow straight into a model's context as fact.
        if (sha256(body) !== digest) {
            throw new ArtifactError('ARTIFACT_CORRUPT', `stored bytes for ${digest} do not match their digest`);
        }
        return body;
    }
    byteLength(digest) {
        try {
            return statSync(this.binPath(digest)).size;
        }
        catch {
            return 0;
        }
    }
    remove(digest) {
        const bytes = this.byteLength(digest);
        rmSync(this.binPath(digest), { force: true });
        rmSync(this.infoPath(digest), { force: true });
        return bytes;
    }
    /** Every digest currently stored, with the bytes it occupies. */
    entries() {
        return [...this.digests()].map(digest => ({ digest, bytes: this.byteLength(digest) }));
    }
    /**
     * Reclaim temp files abandoned by a process that died mid-write.
     *
     * `putSync` unlinks its own temp on a caught failure, but a SIGKILL or power
     * loss between create and rename runs no catch block at all. With the old
     * identity-derived name a later retry from the same writer reused (and so
     * overwrote) that path; with a per-call `randomUUID` every retry picks a new
     * name, so the corpse is unreachable forever — a container that crash-loops
     * mid-write accumulates full artifact-sized hidden files without bound.
     *
     * `minAgeMs` is the safety margin: a temp file younger than that may belong
     * to a write happening RIGHT NOW in another process, and deleting it would
     * turn a healthy concurrent write into a spurious failure. An hour is far
     * beyond any single synchronous write and far below the interval at which
     * leaked files matter.
     *
     * @param now - clock, injectable for tests.
     * @param minAgeMs - only reclaim temps older than this.
     * @returns how many files were removed and how many bytes they held.
     */
    sweepTemps(now = Date.now(), minAgeMs = TEMP_SWEEP_MARGIN_MS) {
        const base = join(this.root, 'sha256');
        if (!existsSync(base))
            return { removed: 0, bytesFreed: 0 };
        let removed = 0;
        let bytesFreed = 0;
        for (const prefix of readdirSync(base)) {
            const dir = join(base, prefix);
            for (const file of readdirSync(dir)) {
                if (!file.endsWith('.tmp'))
                    continue;
                const path = join(dir, file);
                try {
                    const stat = statSync(path);
                    if (now - stat.mtimeMs < minAgeMs)
                        continue;
                    // `unlinkSync`, NOT `rmSync(force)`. Two stores sharing a root can
                    // both pass the statSync above before either unlinks; with `force`
                    // the loser's call also succeeds on the now-missing path and both
                    // would count the same file, reporting the bytes as reclaimed twice.
                    // Without `force`, the loser gets ENOENT and correctly counts
                    // nothing — the counters then mean "what THIS sweeper reclaimed".
                    unlinkSync(path);
                    removed += 1;
                    bytesFreed += stat.size;
                }
                catch {
                    // Gone already (another sweeper won, or the owning writer cleaned up
                    // after its own failure), or not ours to remove. Either way this
                    // invocation reclaimed nothing here.
                }
            }
        }
        return { removed, bytesFreed };
    }
    /** Every digest currently stored. */
    *digests() {
        const base = join(this.root, 'sha256');
        if (!existsSync(base))
            return;
        for (const prefix of readdirSync(base)) {
            for (const file of readdirSync(join(base, prefix))) {
                if (file.endsWith('.bin'))
                    yield file.slice(0, -4);
            }
        }
    }
}
