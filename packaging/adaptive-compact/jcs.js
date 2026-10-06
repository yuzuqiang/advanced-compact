/**
 * RFC 8785 JSON Canonicalization (JCS), scoped to what `summary_sha256`
 * needs (docs/05-sidecar-protocol.md §3.1):
 *
 *   summary_sha256 = hex( SHA-256( UTF-8( JCS( summary ) ) ) )
 *
 * Not a general RFC 8785 implementation — the wire `summary` payload
 * (`WireContentBlock[]`) is a shallow, known, non-exotic shape with no
 * numeric fields at all, so JCS's number-canonicalization rule (matching
 * ECMAScript's own `Number::toString`) never applies to this payload.
 * Verified directly (not just reasoned about) that plain `JSON.stringify`
 * per primitive is already JCS-compliant here: it does not escape
 * U+2028/U+2029 (RFC 8785's minimal-escaping rule), and default `.sort()`
 * on JS strings already compares by UTF-16 code unit, including surrogate
 * pairs — exactly RFC 8785's required key order. The only real work left is
 * recursively re-serializing with object keys sorted.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive/jcs
 */
import { createHash } from 'node:crypto';
/**
 * Canonicalize a value per RFC 8785, for this package's own scope (see
 * module doc — no numeric payload has been exercised against a general
 * JCS test vector suite, only the specific claims above).
 *
 * @param value - a plain JSON-serializable value (no `undefined`, no
 *   functions, no cycles — the same constraints `JSON.stringify` itself
 *   already has).
 * @returns the canonical JSON text.
 */
export function canonicalizeJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalizeJson).join(',')}]`;
    // Cast, not narrowing: confirmed object, non-null, non-array above — the
    // only remaining member of JsonValue's union — but Array.isArray's
    // negation does not narrow a `readonly X[] | {...}` union on its own.
    const obj = value;
    const keys = Object.keys(obj).sort();
    const entries = keys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
    return `{${entries.join(',')}}`;
}
/**
 * `summary_sha256` per docs/05-sidecar-protocol.md §3.1: hashed over the
 * canonical bytes of `summary` alone, NOT the whole response body (which
 * carries per-request fields like `request_id` that would never let a
 * response's hash match itself).
 *
 * @param summary - the wire `summary` array, no outer wrapper.
 * @returns lowercase hex SHA-256.
 */
export function summarySha256(summary) {
    const canonical = canonicalizeJson(summary);
    return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}
//# sourceMappingURL=jcs.js.map