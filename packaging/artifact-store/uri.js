/**
 * Artifact URI grammar.
 *
 * Deliberately cordis-free so client, wire, and tool programs can validate a
 * URI without loading the host service.
 *
 * The grammar is the security boundary. A digest is the ONLY thing that ever
 * becomes a path component, and it must be exactly 64 lowercase hex characters,
 * so no input can traverse out of the store, reach another scheme, or be
 * smuggled through case-folding. Nothing here concatenates caller text into a
 * path.
 *
 * @module @adaptive-compact/dsh-artifact-store/uri
 */
const ARTIFACT_URI = /^artifact:\/\/sha256\/([0-9a-f]{64})$/;
/**
 * Whether a string is a well-formed artifact URI.
 * @param value - untrusted candidate, possibly from a model or a tool argument.
 * @returns true only for the exact canonical form.
 */
export function isArtifactUri(value) {
    return typeof value === 'string' && ARTIFACT_URI.test(value);
}
/**
 * Extract the digest from an artifact URI.
 * @param value - untrusted candidate.
 * @returns the 64-character lowercase digest, or undefined when malformed.
 */
export function artifactDigest(value) {
    if (typeof value !== 'string')
        return undefined;
    const match = ARTIFACT_URI.exec(value);
    return match?.[1];
}
/**
 * Build an artifact URI from a digest.
 * @param digest - 64-character lowercase hex digest.
 * @returns the canonical URI.
 * @throws when the digest is not canonical — callers must never construct a URI
 * from unvalidated text.
 */
export function artifactUri(digest) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`artifact uri: digest must be 64 lowercase hex characters, got ${JSON.stringify(digest)}`);
    }
    return `artifact://sha256/${digest}`;
}
/** Every artifact URI appearing in a block of text, in first-seen order. */
export function findArtifactUris(text) {
    const seen = new Set();
    const out = [];
    for (const [uri] of text.matchAll(/artifact:\/\/sha256\/[0-9a-f]{64}/g)) {
        if (seen.has(uri))
            continue;
        seen.add(uri);
        out.push(uri);
    }
    return out;
}
//# sourceMappingURL=uri.js.map