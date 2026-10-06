/**
 * Webhook signature verification and replay rejection for the sidecar's
 * outbound event push (SEC-08, docs/05-sidecar-protocol.md §6).
 *
 * A standalone, exported pure-verification utility — NOT wired into
 * `AdaptiveCompactionEngine`. This repo is a library/plugin, not a server:
 * there is no "receive an inbound HTTP webhook" integration point to build
 * here. The real caller is an operator's own webhook-receiving service,
 * which imports this the same way it would import `redactText`/
 * `labelAllowed` from `@adaptive-compact/dsh-artifact-store` — general-
 * purpose exported utilities with no single internal call site either.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive/webhook
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
/** docs/05-sidecar-protocol.md §6's own "建議 300 秒" (recommended 300 seconds). */
const DEFAULT_MAX_SKEW_SECONDS = 300;
/**
 * Verify one webhook delivery's HMAC signature and freshness.
 *
 * Two independent checks, because docs/05 §6 states two independent
 * requirements ("超過時間窗**或**重複 `event_id`" — replay rejection, the
 * second half, is `WebhookReplayGuard` below; signature/freshness alone
 * doesn't dedupe, and a replay guard alone doesn't verify authenticity).
 *
 * `headers.eventId` is itself part of the signed bytes (Codex review): an
 * earlier version signed only `timestamp + "." + body`, which let an
 * attacker replay a captured, still-fresh, validly-signed delivery under a
 * brand-new `X-Compact-Event-Id` — the signature check would still pass
 * (timestamp and body are unchanged), and `WebhookReplayGuard` would admit
 * the forged id as a genuinely new event, defeating replay rejection
 * entirely without ever breaking the signature. Binding the id into the
 * HMAC input means changing it invalidates the signature outright.
 *
 * The fields are LENGTH-PREFIXED, not simply `.`-joined (Codex review, PR
 * #18 round 4): plain concatenation is ambiguous when either field can
 * contain the separator itself — `{eventId:"evt", timestamp:"T.T"}` (a
 * non-canonical, dotted timestamp) and `{eventId:"evt.T", timestamp:"T"}`
 * both join to the identical `"evt.T.T"` prefix, so both sign identically
 * even though `WebhookReplayGuard` treats their `eventId`s as two
 * different events — a fresh delimiter-injection route to the exact
 * replay `event_id` binding was meant to close, reachable without ever
 * breaking the signature. A length prefix on each field makes its
 * boundary a number, not a character that could appear inside the field's
 * own content, so no two distinct (eventId, timestamp) pairs can ever
 * produce the same signed bytes.
 *
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
 * Rejects a repeated `event_id` within the freshness window docs/05 §6
 * requires consumers to enforce. In-memory, per-instance — the same
 * durability tier as `ContextRetrieval`'s own `taintedSessions`/
 * `scannedThrough` (rebuilt from nothing on restart; a webhook receiver's
 * own persistence, if any, is the operator's concern, not this class's).
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
//# sourceMappingURL=webhook.js.map