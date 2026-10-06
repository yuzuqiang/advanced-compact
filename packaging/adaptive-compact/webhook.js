/**
 * Webhook signature verification and replay rejection for sidecar event receivers.
 * These exported utilities do not install an HTTP receiver in the compaction engine.
 * @module adaptive-compact/webhook
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * Default allowed clock skew for webhook freshness checks.
 */
const DEFAULT_MAX_SKEW_SECONDS = 300;
/**
 * Verify HMAC authenticity and timestamp freshness; WebhookReplayGuard separately
 * rejects duplicate event IDs. Sign length-prefixed event ID, timestamp and exact
 * body bytes so changing the ID or inserting delimiters invalidates the signature.
 * @param rawBody - the exact request body bytes the signature was computed
 *   over, as a string — NOT a re-serialized/re-parsed form, which could
 *   differ byte-for-byte from what the sender actually signed.
 * @param headers - the three `X-Compact-*` headers.
 * @param options - the shared HMAC secret and freshness window.
 * @returns `{ok:true}`, or `{ok:false, reason}` naming which check failed.
 */
export function verifyWebhookSignature(rawBody, headers, options) {
    // An empty secret is not "no secret configured" (there is no such state
    // — `secret` is required) but it IS what an operator gets by defaulting
    // an unset environment variable to '' — and Node's createHmac() accepts
    // a zero-length key without complaint. HMAC with a known (here,
    // publicly-guessable-as-empty) key is computable by anyone, defeating
    // the whole point of a shared secret (Codex review, PR #18 round 2).
    // Fail closed rather than silently authenticate every delivery.
    if (options.secret.length === 0)
        return { ok: false, reason: 'bad_signature' };
    const now = options.now ?? Date.now;
    const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
    const timestampSeconds = Number(headers.timestamp);
    if (!Number.isFinite(timestampSeconds))
        return { ok: false, reason: 'malformed_signature' };
    if (Math.abs(now() / 1000 - timestampSeconds) > maxSkewSeconds) {
        return { ok: false, reason: 'stale_timestamp' };
    }
    const prefix = 'v1=';
    if (!headers.signature.startsWith(prefix))
        return { ok: false, reason: 'malformed_signature' };
    const encoded = headers.signature.slice(prefix.length);
    // Buffer.from(_, 'hex') silently stops at the first invalid character
    // and returns whatever it decoded up to that point, rather than
    // throwing — so 'v1=<64 valid hex><garbage>' would decode to the exact
    // same 32 bytes as the correctly-formatted signature alone, and both
    // the length check and timingSafeEqual below would accept it (Codex
    // review, PR #18 round 2). Reject anything that is not EXACTLY 64 hex
    // characters before ever decoding it.
    if (!/^[0-9a-f]{64}$/i.test(encoded))
        return { ok: false, reason: 'malformed_signature' };
    const provided = Buffer.from(encoded, 'hex');
    // Length-prefixed, not plain `.`-joined — see this function's own doc
    // comment for why (Codex review, PR #18 round 4).
    const expected = Buffer.from(createHmac('sha256', options.secret)
        .update(`${headers.eventId.length}:${headers.eventId}.${headers.timestamp.length}:`
        + `${headers.timestamp}.${rawBody}`)
        .digest('hex'), 'hex');
    // Length check first: timingSafeEqual throws on a length mismatch rather
    // than returning false, and the length check itself leaks nothing an
    // attacker doesn't already know (a fixed-length hex digest).
    if (provided.length !== expected.length)
        return { ok: false, reason: 'bad_signature' };
    // Constant-time comparison — not `===`/`.equals()` — a signature check is
    // exactly the kind of comparison a timing side channel can undermine.
    if (!timingSafeEqual(provided, expected))
        return { ok: false, reason: 'bad_signature' };
    return { ok: true };
}
/**
 * Reject duplicate event IDs within the freshness window.
 * State is per-instance and in memory; receivers provide any required persistence.
 */
export class WebhookReplayGuard {
    windowSeconds;
    seen = new Map();
    constructor(windowSeconds = DEFAULT_MAX_SKEW_SECONDS) {
        this.windowSeconds = windowSeconds;
    }
    /**
     * @param eventId - `X-Compact-Event-Id`.
     * @param timestampSeconds - the delivery's own timestamp, unix seconds.
     * @param nowSeconds - injectable for tests; defaults to `Date.now() / 1000`.
     * @returns `true` the first time this `eventId` is admitted within the
     *   window, `false` on any repeat.
     */
    admit(eventId, timestampSeconds, nowSeconds = Date.now() / 1000) {
        for (const [id, seenAt] of this.seen) {
            if (nowSeconds - seenAt > this.windowSeconds)
                this.seen.delete(id);
        }
        if (this.seen.has(eventId))
            return false;
        this.seen.set(eventId, timestampSeconds);
        return true;
    }
}
