/**
 * Artifact failure classes.
 *
 * `ARTIFACT_MISSING` and `ARTIFACT_FORBIDDEN` deliberately carry the SAME
 * outward message: telling a caller "this exists but you may not read it"
 * confirms the existence of another tenant's content, which is the leak the
 * reference model exists to prevent. The distinction stays in the audit log.
 *
 * @module @adaptive-compact/dsh-artifact-store/errors
 */
const OUTWARD = {
    ARTIFACT_MISSING: 'artifact not available',
    ARTIFACT_FORBIDDEN: 'artifact not available',
    ARTIFACT_NOT_TEXT: 'artifact is not text; read it as bytes',
    ARTIFACT_CORRUPT: 'artifact content does not match its digest',
    ARTIFACT_INVALID_URI: 'not a valid artifact uri',
    ARTIFACT_WRITE_FAILED: 'artifact could not be stored',
};
export class ArtifactError extends Error {
    code;
    name = 'ArtifactError';
    /**
     * @param code - stable failure class.
     * @param detail - diagnostic detail for logs; NOT included in {@link outward}.
     * @param options - optional original failure.
     */
    constructor(code, detail, options) {
        super(`${code}: ${detail}`, options);
        this.code = code;
    }
    /** The message safe to hand back to a model or another tenant. */
    outward(uri) {
        return uri === undefined ? OUTWARD[this.code] : `${OUTWARD[this.code]} (${uri})`;
    }
}
//# sourceMappingURL=errors.js.map