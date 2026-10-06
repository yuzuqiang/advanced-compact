/**
 * Credential redaction applied before anything is stored, embedded, or sent.
 *
 * The replacement keeps a short digest suffix so the same secret is recognisably
 * the same across occurrences without being recoverable — useful when a model
 * must reason about "the token from step 3" without ever seeing it.
 *
 * This is a defence in depth, not a guarantee: no pattern set catches every
 * credential format. Anything genuinely sensitive belongs behind a `secret`
 * label and a local-only route, not behind this regex list.
 *
 * @module @adaptive-compact/dsh-artifact-store/redact
 */
import { createHash } from 'node:crypto';
import { isUtf8 } from "./blob.js";
/** Ordered: earlier rules win on overlapping matches. */
export const DEFAULT_RULES = [
    { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { name: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
    // Case-insensitive: several providers issue upper-case `SK-` prefixes, and a
    // lower-case-only pattern silently passes them through. Caught by SEC-02.
    { name: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gi },
    { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    // [^\s"\\]+, not \S+: this text is not always free-standing header prose
    // — a tool-call argument can embed it inside a JSON string value, e.g.
    // {"header":"Authorization: Bearer <token>"}. \S+ does not stop at `"`,
    // so it swallowed the token's closing quote AND the object's closing
    // brace as part of "the token", leaving genuinely unterminated JSON
    // behind — a provider validating a replayed tool call could reject the
    // whole summarization request over it. A real bearer token is never
    // itself going to contain a literal `"`, so excluding it costs nothing
    // against the plain-header case this pattern also has to keep matching.
    //
    // Excluding `"` alone is not enough: when the surrounding JSON string
    // value itself contains a literal quote (an argument built from text a
    // user typed, say), that quote appears in the SOURCE as an escaped pair
    // `\"`, two characters — and `\` was still in-charset. The match
    // consumed the backslash (stopping only at the quote right after it),
    // which deletes the escape from an otherwise-matched pair without
    // touching the quote it was escaping: a `\"..X..\"` pair becomes
    // `\"..X..` followed by a now-BARE `"`, which a JSON parser reads as the
    // string's own terminator, corrupting the document a different way than
    // the original bug. Excluding `\` too stops the match one character
    // earlier, leaving the escape pair on the far side of the token intact.
    { name: 'bearer_header', pattern: /(?<=authorization:\s*bearer\s+)[^\s"\\]+/gi },
];
/** Shannon entropy in bits per character. */
export function shannonEntropy(text) {
    if (text.length === 0)
        return 0;
    const counts = new Map();
    for (const ch of text)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / text.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}
const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;
const ENTROPY_THRESHOLD = 4.0;
// A sha256 digest is 64 hex chars — comfortably over the entropy heuristic's
// own threshold by construction, since that's what a well-distributed hash
// looks like. It is not a secret: computing one requires the plaintext AND
// resolving it back to content still goes through the store's own ACL
// (SEC-01), so redacting it here only breaks a reference this pipeline
// itself generated, for no confidentiality gain. Found by SEC-03's
// composition test: this exact corruption hit a real rendered checkpoint's
// "## Anchors" artifact citation, the same failure mode already fixed once
// in tool-result-offload's surface preview for the identical reason.
//
// Shielded by substitution rather than by checking what precedes a
// HIGH_ENTROPY match: '/' is itself inside that pattern's own charset, so a
// match can extend backward across "//sha256/" and swallow the scheme along
// with the digest — the match does not reliably start exactly at the
// digest, so a fixed-offset "is the 18 chars before this the URI prefix"
// check silently never fires. (Caught only by SEC-03's real checkpoint
// text; an isolated test with a repetitive, low-entropy fake digest passed
// against that broken version for an unrelated reason — its "digest" never
// crossed the entropy threshold in the first place.) Swapping the whole URI
// for a placeholder outside HIGH_ENTROPY's charset before that pass runs
// sidesteps match-boundary reasoning entirely.
//
// The trailing (?!...) is load-bearing, not decoration: this processes
// UNTRUSTED text, and without it "artifact://sha256/<64 hex><more hex or
// base64 chars>" shields exactly the first 64 characters as a "trusted"
// URI, leaving a real secret concatenated right after it too short (< 32
// chars) for HIGH_ENTROPY to ever see on its own — an attacker-craftable
// bypass, not a hypothetical one. uri.ts's own isArtifactUri() is fully
// anchored (^...$) for the same reason: a real digest is exactly 64 lower-
// hex characters, never more.
//
// `=` belongs in that excluded set too, not just HIGH_ENTROPY's own base
// charset: HIGH_ENTROPY's pattern is the base charset PLUS up to two
// trailing `=` (base64 padding), so "artifact://sha256/<64 hex>==" is a
// span that meets HIGH_ENTROPY's own length and padding grammar as a
// whole — "sha256/<64 hex>==" alone crosses the entropy threshold — yet
// the lookahead without `=` still treats the 64 hex characters as a
// complete, well-formed URI and shields exactly that prefix, silently
// exempting the whole span with zero hits recorded. A genuine artifact URI
// rendered into prose is never immediately followed by `=` (whitespace or
// punctuation follows a citation, not base64 padding), so excluding it
// costs nothing real while closing an attacker-craftable disguise: any
// 64-hex-char secret can be dressed up with this exact prefix to ride the
// same exemption a genuine digest relies on.
const ARTIFACT_URI = /artifact:\/\/sha256\/[0-9a-f]{64}(?![A-Za-z0-9+/_=-])/g;
// Two reserved delimiters used while shielding artifact URIs from the sweep
// below. Built with String.fromCodePoint rather than typed as literal
// characters: both are invisible in an ordinary editor or terminal by design
// — that's the entire point of the Private Use Area — which makes a literal
// placed directly in source impossible for a reviewer (or the author) to
// eyeball-verify, and easy to lose in a copy/paste or a tool that doesn't
// round-trip non-ASCII bytes faithfully. Spelling the codepoints out keeps
// the intent legible to anyone reading this file.
//
// U+E000/U+E001 rather than NUL (U+0000): a NUL byte works identically
// against collisions, but git treats a file containing one as binary — the
// diff for this whole module would stop rendering.
//
// PLACEHOLDER marks a shield token (`PLACEHOLDER index PLACEHOLDER`, e.g.
// the two-codepoint stand-in for one URI); ESCAPE marks one genuine
// occurrence of either reserved codepoint that was actually present in the
// untrusted input, not inserted by this function. Keeping the two roles on
// SEPARATE codepoints — rather than one codepoint escaping itself by
// doubling — is what makes restoration unambiguous even when genuine
// reserved-codepoint input sits directly adjacent to a shield token with no
// separator between them, which a same-codepoint scheme cannot resolve by
// local adjacency alone (see below).
//
// A single-codepoint self-doubling scheme (genuine PLACEHOLDER → PLACEHOLDER
// PLACEHOLDER) was tried first, guarded by a (?<!P)P(\d+)P(?!P) restore
// pattern to stop two adjacent escaped-double pairs from lending one
// character each to a false match. That guard fixed the collision it was
// built for, but a genuine PLACEHOLDER sitting immediately next to a real
// URI defeats it a different way: escaping the input P then shielding the
// URI right after produces PPP0P — the shielded token's own opening P is now
// itself preceded by P (part of the escaped pair), so the negative
// lookbehind refuses to treat it as an opening delimiter, and NOTHING
// matches. The token is left as literal text, and the final unescape pass
// (blindly collapsing PP → P) mangles it further instead of restoring the
// URI — exactly the corruption a same-codepoint scheme cannot avoid, because
// after escaping, an escaped pair's trailing P and a shield token's leading
// P are the same character with no way to tell them apart by adjacency.
//
// Two codepoints sidestep the ambiguity instead of guarding around it: an
// ESCAPE is NEVER part of a shield token (step 2 below emits shield tokens
// using PLACEHOLDER alone), so any ESCAPE found during restore always starts
// a genuine-content escape pair, and any PLACEHOLDER not immediately
// preceded by an ESCAPE always starts a shield token. RESTORE_TOKEN encodes
// both cases as one alternation, resolved in a single left-to-right,
// non-overlapping pass — there is no second "collapse the escaping"
// pass racing a "restore the shields" pass for adjacent runs to fall
// between.
//
// Escaping a genuine ESCAPE character itself (not just genuine PLACEHOLDER)
// is what closes the gap in the FIRST two-codepoint attempt: that version
// escaped PLACEHOLDER to a second codepoint but unescaped every occurrence
// of that codepoint unconditionally afterward, corrupting input that
// genuinely contained it for reasons unrelated to this function's own
// escaping. Escaping both reserved codepoints up front, and only ever
// decoding an ESCAPE-prefixed pair back to its single literal character,
// means a bare (unescaped) ESCAPE cannot survive to the restore pass at all,
// and a bare PLACEHOLDER can only be one this function inserted.
const PLACEHOLDER = String.fromCodePoint(0xE000);
const ESCAPE = String.fromCodePoint(0xE001);
const RESTORE_TOKEN = new RegExp(`${ESCAPE}(${ESCAPE}|${PLACEHOLDER})|${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g');
function marker(name, value) {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 4);
    return `[REDACTED:${name}:${digest}]`;
}
/**
 * Redact credentials in text.
 * @param text - untrusted content.
 * @param rules - rule set; defaults to {@link DEFAULT_RULES}.
 * @returns the rewritten text and per-rule hit counts.
 */
export function redactText(text, rules = DEFAULT_RULES) {
    const hits = {};
    let out = text;
    // Caller-supplied rules run FIRST, against the raw text, before the
    // artifact-URI exemption below ever touches it. A caller can pass a rule
    // that specifically targets artifact references (a policy suppressing
    // reference disclosure entirely, say) — shielding URIs before any rule
    // gets to run would silently defeat exactly that rule, restoring the URI
    // unchanged with no hit reported, regressing the documented `rules`
    // parameter's own contract.
    for (const rule of rules) {
        out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match) => {
            hits[rule.name] = (hits[rule.name] ?? 0) + 1;
            return marker(rule.name, match);
        });
    }
    // Shielded from the entropy sweep below, for whichever URIs survived the
    // rules pass above intact: each is swapped for a PLACEHOLDER-delimited
    // token, which sits outside every pattern's charset and so cannot be
    // swallowed into a later match. Escaping any pre-existing ESCAPE or
    // PLACEHOLDER in the input first (ESCAPE before PLACEHOLDER, so the
    // ESCAPE characters that step inserts are not themselves re-escaped by
    // the step after it) is what makes this safe against untrusted input;
    // see the constants' own comment for why two codepoints, not one.
    const shielded = [];
    out = out.replaceAll(ESCAPE, ESCAPE + ESCAPE).replaceAll(PLACEHOLDER, ESCAPE + PLACEHOLDER)
        .replace(ARTIFACT_URI, (match) => {
        shielded.push(match);
        return `${PLACEHOLDER}${shielded.length - 1}${PLACEHOLDER}`;
    });
    // Entropy sweep last, so a token already matched by a named rule is not
    // re-marked, and so the markers themselves are never re-redacted.
    out = out.replace(HIGH_ENTROPY, (match) => {
        if (match.startsWith('REDACTED'))
            return match;
        if (shannonEntropy(match) < ENTROPY_THRESHOLD)
            return match;
        hits.high_entropy = (hits.high_entropy ?? 0) + 1;
        return marker('high_entropy', match);
    });
    // One combined pass restores both genuine escaped content and shield
    // tokens together, left to right, non-overlapping — not two separate
    // passes (unescape, then unshield, or vice versa) that could each read
    // into the other's output at an adjacency neither alone produced. See
    // RESTORE_TOKEN's own comment.
    out = out.replace(RESTORE_TOKEN, (_, escaped, index) => (escaped !== undefined ? escaped : shielded[Number(index)]));
    return { text: out, hits };
}
const ARTIFACT_URI_IN_TEXT = /artifact:\/\/sha256\/[0-9a-f]{64}/g;
const UNRESOLVABLE = '(artifact reference removed: not readable from this session)';
/**
 * Replace an `artifact://` URI this caller cannot resolve with an inert
 * placeholder, leaving genuinely-resolvable references untouched.
 *
 * `redactText`'s own artifact-URI exemption above (see `ARTIFACT_URI`'s own
 * comment) trusts SYNTAX alone — a well-formed "artifact://sha256/<64 hex>"
 * is shielded from the entropy sweep unconditionally, whether or not this
 * store ever issued it — so an attacker-chosen 64-hex-character credential
 * dressed up in this exact prefix rides that exemption with certainty,
 * escaping redaction outright instead of facing the entropy heuristic's own
 * coin-flip odds for bare hex. Callers that hold a way to authenticate a
 * reference run this BEFORE `redactText`, so an unresolvable one is gone
 * before its shape could exempt it. `redactText` itself takes no resolver:
 * some callers (a checkpoint's own rendering, a tool-result surface, this
 * module's own `redactBuffer`) have a session or store to authenticate
 * against, but `redactText` is also called from places that do not, and a
 * function whose safety silently depended on an argument every caller
 * forgot to pass is worse than one that names the gap in its own doc.
 *
 * @param text - untrusted content that may contain artifact URIs.
 * @param resolve - returns `undefined` for a URI this caller cannot read;
 *   omitting it leaves `text` unchanged — shape-based trust, the pre-existing
 *   behavior, not a new failure mode.
 * @returns `text` with unresolvable references replaced.
 */
export function scrubUnresolvableUris(text, resolve) {
    if (resolve === undefined)
        return text;
    return text.replace(ARTIFACT_URI_IN_TEXT, uri => (resolve(uri) === undefined ? UNRESOLVABLE : uri));
}
/**
 * Redact a buffer, leaving non-UTF-8 content untouched.
 * @param buffer - raw bytes.
 * @param resolveArtifact - see `scrubUnresolvableUris`; omit to fall back to
 *   `redactText`'s own shape-based artifact-URI trust.
 * @returns the possibly-rewritten bytes and hit counts.
 */
export function redactBuffer(buffer, resolveArtifact) {
    // A lossy decode means this is not text; rewriting it would corrupt the bytes.
    if (!isUtf8(buffer))
        return { buffer, hits: {} };
    const text = buffer.toString('utf8');
    const scrubbed = scrubUnresolvableUris(text, resolveArtifact);
    const outcome = redactText(scrubbed);
    if (Object.keys(outcome.hits).length === 0 && scrubbed === text)
        return { buffer, hits: {} };
    return { buffer: Buffer.from(outcome.text, 'utf8'), hits: outcome.hits };
}
//# sourceMappingURL=redact.js.map