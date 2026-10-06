/**
 * Canonicalize the sidecar summary array for its SHA-256.
 * The supported wire blocks contain no numeric fields; this is not a general
 * RFC 8785 number-canonicalization implementation. Object keys use UTF-16 order
 * and primitives use JSON.stringify escaping.
 * @module adaptive-compact/jcs
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
 * Hash canonical UTF-8 bytes of summary alone, excluding per-request response fields.
 * @param summary - the wire `summary` array, no outer wrapper.
 * @returns lowercase hex SHA-256.
 */
export function summarySha256(summary) {
    const canonical = canonicalizeJson(summary);
    return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}
