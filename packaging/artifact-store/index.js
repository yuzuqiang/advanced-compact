/**
 * Content-addressed artifact storage for offloaded tool output (`ctx.artifactStore`).
 *
 * The premise of "artifact first, summary second": a large tool result is
 * written here in full, and only a head/tail excerpt plus its URI stays on the
 * model-visible surface. Without this, offloading is just a slower way to lose
 * the middle of a compiler log.
 *
 * @module @adaptive-compact/dsh-artifact-store
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BlobStore, isUtf8, sha256, splitLines, TEMP_SWEEP_MARGIN_MS } from "./blob.js";
import { chunkText } from "./chunk.js";
import { resolveConfig } from "./config.js";
import { ArtifactError } from "./errors.js";
import { highestLabel, ReferenceStore } from "./reference.js";
import { redactBuffer } from "./redact.js";
import { alignUtf8, indexLines, lineAt, lineRangeToBytes } from "./text.js";
import { artifactDigest, artifactUri, isArtifactUri } from "./uri.js";
// `export type *` re-exports types only, so this value needs naming explicitly.
// It is part of the public surface: consumers ordering or comparing labels must
// use the same ordering the store enforces, not their own copy.
export { SECURITY_LABEL_ORDER } from "./types.js";
export { ArtifactError } from "./errors.js";
export { artifactDigest, artifactUri, findArtifactUris, isArtifactUri } from "./uri.js";
export { chunkText } from "./chunk.js";
export { DEFAULT_RULES, redactText, shannonEntropy } from "./redact.js";
export { highestLabel, labelAllowed } from "./reference.js";
export { resolveConfig, DEFAULTS } from "./config.js";
const labelSchema = z.union([
    z.const('public'), z.const('internal'), z.const('confidential'), z.const('secret'),
]);
/** Content-addressed artifact storage with per-reference authorization. */
export class ArtifactStore extends Service {
    static inject = [];
    static Config = z.object({
        root: z.string(),
        durability: z.union([z.const('fsync'), z.const('best-effort')]),
        maxArtifactBytes: z.number().step(1).min(1),
        maxTotalBytes: z.number().step(1).min(1),
        retentionDays: z.number().step(1).min(1),
        chunkLines: z.number().step(1).min(1),
        chunkOverlapLines: z.number().step(1).min(0),
        redactSecrets: z.boolean(),
        defaultSecurityLabel: labelSchema,
        registerTools: z.boolean(),
        maxToolReadBytes: z.number().step(1).min(1),
    });
    config;
    blobs;
    refs;
    /**
     * Counters for telemetry; never contain artifact content.
     *
     * `deduplicated` undercounts under real concurrent PROCESSES (not threads)
     * writing the same digest at once: `BlobStore.putSync`'s dedup check is
     * read-then-act (info() + has(), then write) with no cross-process lock, so
     * several racers can all observe "not present yet" before any of them
     * finishes, and each correctly reports itself a first writer at the moment
     * it checked. Measured directly (ST-04, which holds all 12 processes on a
     * stdin barrier and releases them together): ALL TWELVE report
     * `deduplicated: false`, on every run — the window is not narrow, it is
     * whatever the slowest racer's write takes. The BLOB itself is not at risk:
     * each write goes to a temp file named with a per-call `randomUUID()`, then
     * is published by an atomic rename, so exactly one correct file survives no
     * matter how the writers' identities compare. ST-04 verifies this directly
     * for separate PROCESSES on every run; worker threads and separate PID
     * namespaces (containers sharing a volume) are closed by the same
     * construction but have no test of their own. Only this counter's precision
     * is affected — treat
     * `deduplicated`/`writes` as a lower/upper bound on true storage savings
     * under concurrent load, not an exact count. See docs/11-review-log.md §21.
     */
    stats = {
        writes: 0, deduplicated: 0, reads: 0, missing: 0, forbidden: 0,
        corrupt: 0, redactionHits: {},
    };
    constructor(ctx, config = {}) {
        super(ctx, 'artifactStore');
        this.config = resolveConfig(config);
        mkdirSync(join(this.config.root, 'refs', 'index'), { recursive: true });
        this.blobs = new BlobStore(this.config.root, this.config.durability);
        this.refs = new ReferenceStore(this.config.root);
        // Reclaim temps orphaned by a previous run that was killed mid-write.
        //
        // Deliberately at CONSTRUCTION rather than only in `sweep()`. Retention
        // sweeping is an operator-scheduled job (docs/06-telemetry-ops.md lists it
        // on the deployment checklist) and `sweep()` has no caller inside this
        // repo at all — so a deployment that never wires up that schedule would
        // accumulate orphaned temps forever. That is tolerable for retention,
        // where the operator opted into the tradeoff, but not here: an orphaned
        // temp has no reference pointing at it and no digest-named file, so it is
        // invisible to every other reclamation path. The one moment a restarted
        // container is guaranteed to reach is the store being constructed.
        //
        // Failure is logged, never thrown: a store that cannot start because a
        // stale temp could not be unlinked would be a far worse outcome than the
        // leak it is trying to prevent.
        this.reclaimTemps(ctx);
        // A startup sweep alone is not enough. Two windows stay open without a
        // recurring pass:
        //
        //   1. The COMMON crash case — a container that dies mid-write and
        //      restarts within the hour leaves a temp younger than the safety
        //      margin, which the startup sweep correctly skips.
        //   2. PEER crashes — when several processes share a root, another writer
        //      can strand a temp at any time after this store started. Its own
        //      timer dies with it, so only a surviving peer can reclaim it.
        //
        // A one-shot follow-up covers (1) and misses (2) entirely, which is why
        // this repeats rather than firing once. `unref` so a pending timer can
        // never hold the process open, and the effect disposer clears it so a
        // short-lived store does not fire after teardown.
        const recurring = setInterval(() => { this.reclaimTemps(ctx); }, TEMP_SWEEP_MARGIN_MS + 60_000);
        recurring.unref();
        ctx.effect(() => () => { clearInterval(recurring); });
        if (this.config.registerTools) {
            // Optional: a headless composition may have no tool registry at all.
            ctx.inject(['tools'], (toolCtx) => {
                // Imported lazily so the package does not hard-depend on dsh-tools.
                // The import resolves on a later tick, which can lose a race with
                // disposal — touching `toolCtx.tools` after the scope closes throws
                // "inactive context" as an unhandled rejection. The flag makes the
                // late callback a no-op instead, and the failure path is reported
                // rather than swallowed so a genuine load error stays visible.
                let closed = false;
                toolCtx.effect(() => () => { closed = true; });
                void import("./tools.js").then(({ registerArtifactTools }) => {
                    if (closed)
                        return;
                    // `ctx.tools` exists here by construction — inject() only calls back
                    // once the service is present — but Context's static type cannot know
                    // which key was injected.
                    registerArtifactTools(toolCtx, this);
                }).catch((error) => {
                    ctx.logger?.warn(`artifact tools not registered: ${String(error)}`);
                });
            });
        }
    }
    /**
     * Reclaim orphaned temps, reporting rather than throwing.
     *
     * A store that refuses to start because a stale temp could not be unlinked
     * would be a far worse outcome than the leak it is trying to prevent.
     */
    reclaimTemps(ctx) {
        try {
            const reclaimed = this.blobs.sweepTemps();
            if (reclaimed.removed > 0) {
                ctx.logger?.info(`artifact store: reclaimed ${reclaimed.removed} orphaned temp file(s), `
                    + `${reclaimed.bytesFreed} bytes — a previous run was interrupted mid-write`);
            }
        }
        catch (error) {
            ctx.logger?.warn(`artifact store: orphaned-temp sweep failed: ${String(error)}`);
        }
    }
    // ── writing ──────────────────────────────────────────────────────────────
    /**
     * Store bytes and record one reference to them.
     *
     * Synchronous throughout: `ToolResultPruner.pruneSession()` is synchronous
     * and must append the shadow price and its replacement adjacently, so a write
     * that yielded would break that contract.
     *
     * Deduplication skips the BLOB write only. A reference is always recorded —
     * an early return on a digest hit would leave the second session invisible to
     * garbage collection, which would then delete bytes that are still in use.
     *
     * @param bytes - content to store.
     * @param ref - provenance and tenancy for this use of the content.
     * @param hints - optional overrides for sniffed blob properties.
     * @returns the URI, blob properties, and the reference just recorded.
     */
    putSync(bytes, ref, hints) {
        const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
        const originalSha256 = sha256(raw);
        const originalByteLength = raw.byteLength;
        // Widened deliberately: `subarray` and the redactor both yield buffers over
        // ArrayBufferLike, and narrowing back would be a cast, not a guarantee.
        let body = raw;
        let redacted = false;
        if (this.config.redactSecrets) {
            // Authenticates a `redactText`-exempted "artifact://sha256/<64 hex>"
            // against THIS store's own references before it can ride that
            // syntax-only exemption — see scrubUnresolvableUris' own doc.
            //
            // NOT `this.principalFor(ref.sessionId)`: that always issues a
            // principal for the STORE's own configured tenant, but the reference
            // this exact call is about to record (below) can carry its own
            // `ref.tenantId` override instead. Using principalFor() here would
            // silently check the wrong tenant whenever a caller supplies one,
            // finding zero references for ANY genuine citation and stripping it
            // as if it were unresolvable — the same failure mode this fix exists
            // to close, self-inflicted. Mirroring the reference's own resolution
            // (`ref.tenantId ?? this.config.tenantId`, right below) instead of
            // going through principalFor() keeps the two in lockstep by
            // construction: whatever tenant this write is actually recorded
            // under is exactly the tenant this check searches.
            //
            // maxLabel mirrors THIS write's own securityLabel (Codex review,
            // round 8), not a fixed 'confidential' ceiling: a hardcoded ceiling
            // meant a secret-labelled write (e.g. compaction-adaptive's
            // spillOverflow() preserving an evicted secret anchor) could never
            // authenticate a citation to another secret artifact in the same
            // tenant/session — the citation would be scrubbed as "unresolvable"
            // by the same mechanism meant to preserve it, inside the very call
            // that was supposed to keep it. Whoever is trusted to WRITE content
            // at this label is trusted to cite a reference at that label; a
            // lower-labelled write still can't authenticate a secret citation,
            // which is the correct, tighter direction to fail.
            const resolveArtifact = (uri) => (this.references(uri, {
                tenantId: ref.tenantId ?? this.config.tenantId,
                sessionId: ref.sessionId,
                maxLabel: ref.securityLabel ?? this.config.defaultSecurityLabel,
            }).length > 0 ? uri : undefined);
            const outcome = redactBuffer(body, resolveArtifact);
            // Compared by reference, not `outcome.hits`: scrubUnresolvableUris can
            // rewrite the buffer (an unresolvable reference replaced) without
            // redactText itself reporting any named-rule hit, and redactBuffer
            // returns the SAME buffer reference untouched when nothing changed at
            // all — hits alone would miss a scrub-only change.
            if (outcome.buffer !== body) {
                body = outcome.buffer;
                redacted = true;
                for (const [rule, count] of Object.entries(outcome.hits)) {
                    this.stats.redactionHits[rule] = (this.stats.redactionHits[rule] ?? 0) + count;
                }
            }
        }
        const truncated = body.byteLength > this.config.maxArtifactBytes;
        if (truncated) {
            // Cut on a codepoint boundary so the stored text stays decodable.
            const aligned = alignUtf8(body, 0, this.config.maxArtifactBytes);
            // subarray widens to Buffer<ArrayBufferLike>; the bytes are unchanged.
            body = Buffer.from(body.subarray(0, aligned.end));
        }
        // Reuse the original digest when nothing rewrote the bytes: redaction and
        // truncation are the only things that can change them, and both are known
        // here. Previously this hashed the same buffer three times.
        const digest = body === raw ? originalSha256 : sha256(body);
        const { info: blob, deduplicated } = this.blobs.putSync(body, hints, digest);
        this.stats.writes += 1;
        if (deduplicated)
            this.stats.deduplicated += 1;
        const now = Date.now();
        const reference = this.refs.add({
            sha256: blob.sha256,
            tenantId: ref.tenantId ?? this.config.tenantId,
            sessionId: ref.sessionId,
            ...(ref.sourceEventSeq === undefined ? {} : { sourceEventSeq: ref.sourceEventSeq }),
            ...(ref.callId === undefined ? {} : { callId: ref.callId }),
            ...(ref.toolName === undefined ? {} : { toolName: ref.toolName }),
            securityLabel: ref.securityLabel ?? this.config.defaultSecurityLabel,
            redacted,
            truncated,
            originalSha256,
            originalByteLength,
            createdAt: now,
            // retentionDays: 0 means never expire — a log that outlives the window
            // would otherwise cite URIs that no longer resolve.
            retainUntil: ref.retainForMs !== undefined
                ? now + ref.retainForMs
                : this.config.retentionDays === 0
                    ? Number.MAX_SAFE_INTEGER
                    : now + this.config.retentionDays * 86_400_000,
        });
        return { uri: artifactUri(blob.sha256), blob, reference, deduplicated };
    }
    // ── reading ──────────────────────────────────────────────────────────────
    /** The tenant this store reads and writes as. */
    get tenantId() {
        return this.config.tenantId;
    }
    /**
     * Issue a principal for this store's tenant.
     *
     * Consumers must use this rather than building a `Principal` literal. A
     * hand-built principal that names a different tenant than the store was
     * configured with makes `references()` return empty for artifacts that
     * demonstrably exist — and the caller cannot tell that apart from a genuine
     * miss, so URIs get written off as hallucinated instead of read.
     *
     * @param sessionId - session the read belongs to, for audit correlation.
     * @param maxLabel - ceiling on what this principal may read; defaults to `confidential`.
     */
    principalFor(sessionId, maxLabel = 'confidential') {
        return {
            tenantId: this.config.tenantId,
            ...(sessionId === undefined ? {} : { sessionId }),
            maxLabel,
        };
    }
    /** Intrinsic blob properties. No ACL check: it returns no content. */
    statBlob(uri) {
        const digest = this.requireDigest(uri);
        return this.blobs.info(digest);
    }
    /**
     * References this principal holds for a digest.
     * @returns an empty array when the principal may not read it — indistinguishable,
     * by design, from the artifact not existing.
     */
    references(uri, principal) {
        const digest = artifactDigest(uri);
        if (digest === undefined)
            return [];
        return this.refs.visible(digest, principal);
    }
    /** The effective label of an artifact for a principal: the most restrictive it holds. */
    labelOf(uri, principal) {
        const refs = this.references(uri, principal);
        return refs.length === 0 ? undefined : highestLabel(refs.map(ref => ref.securityLabel));
    }
    /**
     * Read raw bytes.
     * @param uri - artifact identifier.
     * @param range - exclusive-end byte range.
     * @param principal - authorization subject.
     * @throws ARTIFACT_MISSING (also when forbidden), ARTIFACT_CORRUPT.
     */
    readBytes(uri, range, principal) {
        const body = this.authorizedBody(uri, principal);
        const start = Math.max(0, Math.min(range.start, body.byteLength));
        const end = Math.max(start, Math.min(range.end, body.byteLength));
        return Uint8Array.prototype.slice.call(body, start, end);
    }
    /**
     * Read text.
     * @param uri - artifact identifier.
     * @param range - `line` (inclusive, 1-based) or `byte` (exclusive end).
     * @param principal - authorization subject.
     * @param maxBytes - optional ceiling; the slice is cut and marked truncated.
     * @throws ARTIFACT_NOT_TEXT for binary content.
     */
    readText(uri, range, principal, maxBytes) {
        const body = this.authorizedTextBody(uri, principal);
        const index = indexLines(body);
        let start;
        let end;
        let lineStart;
        let lineEnd;
        if (range.unit === 'line') {
            const bytes = lineRangeToBytes(index, body, range.start, range.end);
            ({ start, end, lineStart, lineEnd } = bytes);
        }
        else {
            const aligned = alignUtf8(body, range.start, range.end);
            start = aligned.start;
            end = aligned.end;
            lineStart = lineAt(index, start);
            lineEnd = lineAt(index, Math.max(start, end - 1));
        }
        const ceiling = maxBytes ?? Number.POSITIVE_INFINITY;
        let truncated = false;
        if (end - start > ceiling) {
            const cut = alignUtf8(body, start, start + ceiling);
            end = cut.end;
            lineEnd = lineAt(index, Math.max(start, end - 1));
            truncated = true;
        }
        return { uri, text: body.subarray(start, end).toString('utf8'), lineStart, lineEnd, truncated };
    }
    /**
     * Search inside one artifact.
     * @param pattern - literal text, or a regular expression when `opts.regex`.
     * @returns matching slices with surrounding context lines.
     */
    grep(uri, pattern, opts, principal) {
        const body = this.authorizedTextBody(uri, principal);
        // splitLines drops the phantom element a trailing newline produces, so line
        // numbers here agree with `BlobInfo.lineCount` and with the chunker.
        const lines = splitLines(body.toString('utf8'));
        const maxHits = opts.maxHits ?? 50;
        const context = opts.contextLines ?? 0;
        let matcher;
        if (opts.regex === true) {
            let expression;
            try {
                expression = new RegExp(pattern);
            }
            catch (error) {
                throw new ArtifactError('ARTIFACT_INVALID_URI', `invalid regex: ${String(error)}`, { cause: error });
            }
            matcher = line => expression.test(line);
        }
        else {
            matcher = line => line.includes(pattern);
        }
        const hits = [];
        for (let i = 0; i < lines.length && hits.length < maxHits; i += 1) {
            if (!matcher(lines[i]))
                continue;
            const from = Math.max(0, i - context);
            const to = Math.min(lines.length - 1, i + context);
            hits.push({
                uri,
                text: lines.slice(from, to + 1).join('\n'),
                lineStart: from + 1,
                lineEnd: to + 1,
                truncated: false,
            });
        }
        return hits;
    }
    /** Deterministic line-window chunks for a retrieval index. */
    chunks(uri, principal) {
        let body;
        try {
            body = this.authorizedTextBody(uri, principal);
        }
        catch (error) {
            // Binary artifacts simply have no chunks; an indexer should not have to
            // special-case them.
            if (error instanceof ArtifactError && error.code === 'ARTIFACT_NOT_TEXT')
                return [];
            throw error;
        }
        return chunkText(uri, body.toString('utf8'), {
            chunkLines: this.config.chunkLines,
            chunkOverlapLines: this.config.chunkOverlapLines,
        });
    }
    // ── lifecycle ────────────────────────────────────────────────────────────
    /** Drop one reference. The blob survives until it has no live references. */
    releaseReference(uri, refId) {
        const digest = artifactDigest(uri);
        return digest === undefined ? false : this.refs.remove(refId, digest);
    }
    /**
     * Reclaim space.
     *
     * Expired references go first, then any blob with no live reference. A blob
     * that some live session still points at is never removed, whatever the size
     * pressure — losing it would leave a durable log citing content that no
     * longer exists.
     *
     * Also reclaims temp files orphaned by a process that died mid-write. Those
     * are invisible to the reference layer (they have no digest name yet and no
     * reference points at them), so nothing else would ever collect them; see
     * `BlobStore.sweepTemps` for why a per-call random temp name makes this
     * necessary.
     */
    sweep(now = Date.now()) {
        const expired = this.refs.expire(now);
        // Deliberately NOT `now`. That parameter is a RETENTION clock: callers
        // legitimately pass a future value to expire references early, and
        // forwarding it here would defeat the temp safety margin — classifying a
        // file another process created moments ago as stale, unlinking it, and
        // making that healthy writer fail at renameSync. Temp aging is about
        // whether a write is still in flight, which only wall time can answer.
        const temps = this.blobs.sweepTemps();
        let blobsRemoved = 0;
        let bytesFreed = temps.bytesFreed;
        // One readdir over the 256 prefix directories, with sizes, instead of the
        // three separate walks this used to do (unreferenced pass, totalBytes, then
        // LRU candidates).
        const surviving = [];
        let total = 0;
        for (const entry of this.blobs.entries()) {
            if (this.refs.count(entry.digest) === 0) {
                this.blobs.remove(entry.digest);
                bytesFreed += entry.bytes;
                blobsRemoved += 1;
                continue;
            }
            surviving.push(entry);
            total += entry.bytes;
        }
        // Size pressure. Everything still here is referenced, and a referenced blob
        // is never evicted: a durable log citing it would be left pointing at
        // nothing. Over-budget with no unreferenced blobs left is a real condition
        // the operator has to see.
        if (total > this.config.maxTotalBytes) {
            this.ctx.logger.warn(`artifact store is ${total} bytes, over maxTotalBytes (${this.config.maxTotalBytes}), `
                + `but all ${surviving.length} remaining blobs are still referenced; `
                + 'lower retentionDays or raise maxTotalBytes');
        }
        return { blobsRemoved, refsRemoved: expired.removed, bytesFreed };
    }
    totalBytes() {
        let total = 0;
        for (const digest of this.blobs.digests())
            total += this.blobs.byteLength(digest);
        return total;
    }
    // ── internals ────────────────────────────────────────────────────────────
    requireDigest(uri) {
        const digest = artifactDigest(uri);
        if (digest === undefined) {
            // Never interpolate the raw value into a path; only report its shape.
            throw new ArtifactError('ARTIFACT_INVALID_URI', `expected artifact://sha256/<64 lowercase hex>, got ${JSON.stringify(String(uri).slice(0, 80))}`);
        }
        return digest;
    }
    /**
     * Resolve a URI to bytes the principal is allowed to see.
     *
     * A principal holding no reference gets ARTIFACT_MISSING, not FORBIDDEN:
     * distinguishing the two would confirm that another tenant's content exists
     * at a given digest.
     */
    /**
     * Authorized bytes decoded as text.
     *
     * `readText`, `grep` and `chunks` all need the same string. Each previously
     * re-ran `isUtf8` — which allocates a second full copy of the blob to compare
     * against — and then decoded again. The recorded `BlobInfo.encoding` already
     * answers the question, and `read()` has verified the digest.
     */
    authorizedTextBody(uri, principal) {
        const digest = this.requireDigest(uri);
        const info = this.blobs.info(digest);
        if (info?.encoding === 'binary') {
            throw new ArtifactError('ARTIFACT_NOT_TEXT', `${digest} is binary; use readBytes`);
        }
        const body = this.authorizedBody(uri, principal);
        // Only pay for the round-trip check when the blob has no recorded encoding.
        if (info === undefined && !isUtf8(body)) {
            throw new ArtifactError('ARTIFACT_NOT_TEXT', `${digest} is not valid UTF-8; use readBytes`);
        }
        return body;
    }
    authorizedBody(uri, principal) {
        const digest = this.requireDigest(uri);
        if (this.refs.visible(digest, principal).length === 0) {
            this.stats.forbidden += 1;
            throw new ArtifactError('ARTIFACT_MISSING', `no visible reference to ${digest} for tenant ${principal.tenantId}`);
        }
        try {
            const body = this.blobs.read(digest);
            // Counted here rather than in `readText`, which is the path a model uses
            // LEAST: the omission marker tells it to prefer `artifact_grep`, so a
            // counter that only saw `readText` reported zero retrievals during a run
            // where the model retrieved on every turn. Every content path —
            // readText, readBytes, grep, chunks — funnels through this method, and
            // only a successful read counts.
            this.stats.reads += 1;
            return body;
        }
        catch (error) {
            if (error instanceof ArtifactError && error.code === 'ARTIFACT_MISSING')
                this.stats.missing += 1;
            if (error instanceof ArtifactError && error.code === 'ARTIFACT_CORRUPT')
                this.stats.corrupt += 1;
            throw error;
        }
    }
}
export default ArtifactStore;
//# sourceMappingURL=index.js.map