/**
 * REST transport for the sidecar bridge (docs/05-sidecar-protocol.md §4).
 *
 * The only module in this package that knows about `fetch`, HTTP status
 * codes, or timeouts — modeled on `packages/llm-llamacpp/src/index.ts`'s
 * own outbound-fetch pattern (base URL normalized once, plain-object body,
 * conditional-spread headers, try/catch around `fetch()` → a classified
 * error), extended with real timeout handling that adapter doesn't need
 * (it only forwards a caller-supplied `AbortSignal`; `sidecar.timeoutMs`
 * is a validated-but-previously-dead config field this client finally
 * consumes). `AbortSignal.any` is unavailable — this repo's `engines`
 * floor (`>=18.15.0 <19.0.0 || >=19.6.0`) predates Node 20.3.0 — so the
 * caller signal and an internal timeout are combined by hand.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive/sidecar-client
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { redactText } from '@adaptive-compact/dsh-artifact-store/redact';
/**
 * The surface generation changed between request and response — a 409, or
 * a structurally-successful response whose own `source_generation` doesn't
 * match. Hard-fail: never respects `failOpen` (see `index.ts`'s
 * `sidecarSummarize()` for why — a stale snapshot cannot produce a
 * committable result regardless of which provider computed it).
 */
export class SidecarChangedError extends HarnessError {
    constructor(message) {
        super(message, 'SIDECAR_CHANGED');
    }
}
/**
 * Every other sidecar failure: timeout, connection error, a non-409 non-2xx
 * status, or a structurally invalid 200 body. failOpen-eligible.
 */
export class SidecarRejectedError extends HarnessError {
    reason;
    status;
    constructor(message, reason, status) {
        super(message, 'SIDECAR_REJECTED');
        this.reason = reason;
        if (status !== undefined)
            this.status = status;
    }
}
const REQUIRED_RESPONSE_FIELDS = ['request_id', 'source_generation', 'summary', 'summary_sha256'];
const WIRE_BLOCK_TYPES = new Set(['text', 'artifact_ref', 'code', 'image_ref']);
/**
 * A malformed-but-array-shaped `summary` (e.g. `[null]`, or an element
 * missing/mistyping `type`) used to reach `fromWireContentBlocks()`
 * unvalidated (Codex review): that function reads `block.type` directly,
 * so a bad element threw a raw `TypeError` from deep inside
 * `sidecarSummarize()`'s success path — OUTSIDE the try/catch that wraps
 * only the `compact()` call itself — propagating uncaught and skipping
 * `failOpen` entirely, even when `failOpen: true`. Validating every
 * element's shape HERE, still inside that try/catch, keeps a malformed
 * response a `SidecarRejectedError` like every other structural problem.
 */
function isWireContentBlock(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const block = value;
    if (typeof block.type !== 'string' || !WIRE_BLOCK_TYPES.has(block.type))
        return false;
    return (block.text === undefined || typeof block.text === 'string')
        && (block.artifact_id === undefined || typeof block.artifact_id === 'string')
        && (block.sha256 === undefined || typeof block.sha256 === 'string');
}
function validateCompactResponse(value) {
    if (typeof value !== 'object' || value === null) {
        throw new SidecarRejectedError('sidecar: response body was not a JSON object', 'malformed');
    }
    const body = value;
    for (const key of REQUIRED_RESPONSE_FIELDS) {
        if (!(key in body)) {
            throw new SidecarRejectedError(`sidecar: response missing required field "${key}"`, 'malformed');
        }
    }
    if (typeof body.request_id !== 'string' || typeof body.source_generation !== 'string'
        || typeof body.summary_sha256 !== 'string' || !Array.isArray(body.summary)) {
        throw new SidecarRejectedError('sidecar: response fields had the wrong type', 'malformed');
    }
    // For an anchor-free span, `summary: []` used to pass every check that
    // follows: every() is vacuously true over an empty array, a correctly
    // computed hash of `[]` matches trivially, and findMissingAnchors() has
    // nothing to report missing when there were no anchors to begin with
    // either — so the response reached the success path, returning an
    // empty SummaryResult that discards the compacted span's content
    // without ever recording any of it (Codex review, PR #18 round 3).
    // Matches the native path's own existing empty-output rejection
    // (`summarization produced no text`), one layer over.
    if (body.summary.length === 0) {
        throw new SidecarRejectedError('sidecar: response summary was empty — nothing to commit', 'malformed');
    }
    if (!body.summary.every(isWireContentBlock)) {
        throw new SidecarRejectedError('sidecar: response summary contained a malformed content block', 'malformed');
    }
    // A non-empty array can still be semantically empty (Codex review, PR
    // #18 round 4, fresh evidence after the length===0 check above): for an
    // anchor-free span, `[{type:'text', text:''}]` or `[{type:'text'}]` (no
    // `text` at all — a structurally valid block per isWireContentBlock,
    // since `text` is optional there for artifact_ref/image_ref) still
    // passes every check above given a correspondingly-computed hash, and
    // fromWireContentBlocks() then produces an empty TextBlock — the same
    // content-free "success" the length check exists to prevent, just
    // reached with a non-empty array instead of []. A block counts as
    // meaningful if it carries non-blank text (text/code) or a well-formed
    // artifact reference (artifact_ref/image_ref) — at least one such block
    // must be present.
    //
    // `sha256` must be a real 64-hex-digest SHAPE, not merely non-empty
    // (Codex review, PR #18 round 5, fresh evidence after the round-4
    // blank-text fix): a malformed value like "missing" doesn't even match
    // ARTIFACT_URI_IN_TEXT's own 64-hex-character regex (summary.ts),
    // so it synthesizes into inert, unmatched literal text — not a real
    // reference — when index.ts's own fromWireContentBlocks() runs. THIS
    // check is deliberately only shape validation, not resolvability — this
    // module has no artifact-store access to ask "does this digest actually
    // exist"; index.ts's own sidecarSummarize() runs a SECOND, later check
    // against the real resolver, after scrubUnresolvableUris() has had a
    // chance to replace a well-formed-but-nonexistent reference with its own
    // fixed marker text.
    const hasContent = body.summary.some((block) => {
        const wire = block;
        if (wire.type === 'text' || wire.type === 'code')
            return (wire.text ?? '').trim().length > 0;
        return wire.sha256 !== undefined && /^[0-9a-f]{64}$/i.test(wire.sha256);
    });
    if (!hasContent) {
        throw new SidecarRejectedError('sidecar: response summary contained no meaningful content (blank text, no references)', 'malformed');
    }
    return body;
}
export class SidecarClient {
    endpoint;
    timeoutMs;
    authToken;
    constructor(config) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.timeoutMs = config.timeoutMs;
        this.authToken = config.authToken;
    }
    async compact(request, signal) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        let timedOut = false;
        const onCallerAbort = () => { controller.abort(signal?.reason); };
        signal?.addEventListener('abort', onCallerAbort);
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`sidecar request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        try {
            let response;
            try {
                response = await fetch(`${this.endpoint}/v1/compact`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'Idempotency-Key': request.idempotencyKey,
                        'If-Match': request.ifMatch,
                        ...(this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` }),
                    },
                    body: JSON.stringify(request.body),
                    signal: controller.signal,
                });
            }
            catch (error) {
                // Caller cancellation always wins — the caller's own abort reason
                // should propagate, not a generic transport error masking it.
                signal?.throwIfAborted();
                if (timedOut) {
                    throw new SidecarRejectedError(`sidecar: request timed out after ${this.timeoutMs}ms`, 'timeout');
                }
                throw new SidecarRejectedError(`sidecar: request failed: ${String(error)}`, 'network');
            }
            if (response.status === 409) {
                throw new SidecarChangedError('sidecar: surface generation changed (409)');
            }
            if (!response.ok) {
                // Redacted before it can reach an exception message a caller logs
                // verbatim (sidecarSummarize()'s own catch does exactly that) — a
                // non-2xx body is untrusted content from the sidecar's own error
                // path, which can echo back request data or carry its own
                // diagnostic detail. Redact the FULL detail first, THEN truncate
                // — not the reverse (Codex review, PR #18 round 4): a credential
                // crossing the 400-character cutoff (e.g. a token beginning near
                // character 390) would have its tail sliced off first, leaving a
                // prefix fragment that no longer matches the full-credential
                // redaction pattern, so the fragment survived into the log
                // unredacted. Truncating bounds length; it must never run before
                // redaction gets a chance to see the complete text.
                const detail = await response.text().catch(() => {
                    // Headers arrived (this is the response.ok===false branch, so a
                    // status line was already received) but the body was still
                    // streaming when this rejected — the SAME race the
                    // response.json() catch below already re-checks for, on the
                    // sibling branch that reads a body (Codex review, PR #18 round
                    // 3): a caller abort landing here must not be reported as an
                    // ordinary non-2xx failure at `response.status`, discarding the
                    // caller's own cancellation reason.
                    signal?.throwIfAborted();
                    // The SAME shared timer/controller that governs the initial
                    // fetch() also still governs this read — the configured timeout,
                    // not just the caller's own signal, can be what aborted it
                    // (Codex review, PR #18 round 4, the sibling of round 3's own
                    // fix on the response.json() branch below).
                    if (timedOut) {
                        throw new SidecarRejectedError(`sidecar: request timed out after ${this.timeoutMs}ms`, 'timeout');
                    }
                    // A genuine (non-abort, non-timeout) body-read failure does not
                    // invalidate the STATUS-based classification below — still
                    // report it, just without the body detail this read failed to
                    // produce.
                    return '';
                });
                throw new SidecarRejectedError(`sidecar: request failed with status ${response.status}: `
                    + `${redactText(detail).text.slice(0, 400)}`, 'http', response.status);
            }
            let parsed;
            try {
                parsed = await response.json();
            }
            catch (error) {
                // Headers arrived (response.ok passed above) but the body was
                // still streaming when this rejected — re-check the caller's own
                // signal first, exactly like the fetch() catch above does, so a
                // caller abort that lands here is not misreported as the sidecar
                // having sent malformed JSON (Codex review, PR #18 round 2).
                signal?.throwIfAborted();
                // The SAME shared timer/controller that governs the initial
                // fetch() also still governs this read (cleared only in the
                // outermost finally, once) — so the configured timeout, not just
                // the caller's own signal, can be what aborted this. Without this
                // check a body-read timeout was misreported as 'malformed'
                // instead of 'timeout', breaking the public reason discriminator
                // for exactly the retryable case it exists to identify (Codex
                // review, PR #18 round 3).
                if (timedOut) {
                    throw new SidecarRejectedError(`sidecar: request timed out after ${this.timeoutMs}ms`, 'timeout');
                }
                throw new SidecarRejectedError(`sidecar: response was not valid JSON: ${String(error)}`, 'malformed');
            }
            return validateCompactResponse(parsed);
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onCallerAbort);
        }
    }
}
//# sourceMappingURL=sidecar-client.js.map