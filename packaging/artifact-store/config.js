/**
 * Configuration resolution.
 *
 * Unknown keys are rejected here rather than defaulted away: schemastery keeps
 * untrusted keys on a permissive object schema, so a typo in a deployment's
 * YAML would otherwise silently disable the setting the operator believed they
 * had changed.
 *
 * @module @adaptive-compact/dsh-artifact-store/config
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SECURITY_LABEL_ORDER } from "./types.js";
const KEYS = new Set([
    'root', 'tenantId', 'durability', 'maxArtifactBytes', 'maxTotalBytes', 'retentionDays',
    'chunkLines', 'chunkOverlapLines', 'redactSecrets', 'defaultSecurityLabel',
    'registerTools', 'maxToolReadBytes',
]);
export const DEFAULTS = {
    durability: 'fsync',
    maxArtifactBytes: 64 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024 * 1024,
    retentionDays: 30,
    chunkLines: 120,
    chunkOverlapLines: 20,
    redactSecrets: true,
    defaultSecurityLabel: 'internal',
    registerTools: true,
    maxToolReadBytes: 32 * 1024,
    tenantId: 'default',
};
/** Expand a leading `~` so a YAML-supplied home path behaves as written. */
function expandHome(path) {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
/** `0` is meaningful for retentionDays: it means "never expire". */
function nonNegativeInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`ArtifactStoreConfig: ${name} (${value}) must be a non-negative integer`);
    }
    return value;
}
function positiveInt(name, value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`ArtifactStoreConfig: ${name} (${value}) must be a positive integer`);
    }
    return value;
}
/**
 * Validate and freeze a configuration.
 * @param config - raw plugin configuration.
 * @returns the resolved configuration.
 * @throws on an unknown key or an out-of-range value.
 */
export function resolveConfig(config = {}) {
    for (const key of Object.keys(config)) {
        if (!KEYS.has(key)) {
            throw new Error(`ArtifactStoreConfig: unknown key "${key}" (allowed: ${[...KEYS].join(', ')})`);
        }
    }
    const durability = config.durability ?? DEFAULTS.durability;
    if (durability !== 'fsync' && durability !== 'best-effort') {
        throw new Error(`ArtifactStoreConfig: durability must be "fsync" or "best-effort", got ${JSON.stringify(durability)}`);
    }
    const label = config.defaultSecurityLabel ?? DEFAULTS.defaultSecurityLabel;
    if (!SECURITY_LABEL_ORDER.includes(label)) {
        throw new Error(`ArtifactStoreConfig: defaultSecurityLabel must be one of ${SECURITY_LABEL_ORDER.join(', ')}, got ${JSON.stringify(label)}`);
    }
    const chunkLines = positiveInt('chunkLines', config.chunkLines ?? DEFAULTS.chunkLines);
    const chunkOverlapLines = config.chunkOverlapLines ?? DEFAULTS.chunkOverlapLines;
    if (!Number.isInteger(chunkOverlapLines) || chunkOverlapLines < 0) {
        throw new Error(`ArtifactStoreConfig: chunkOverlapLines (${chunkOverlapLines}) must be a non-negative integer`);
    }
    if (chunkOverlapLines >= chunkLines) {
        // Equal values make the chunker step zero lines and loop forever.
        throw new Error(`ArtifactStoreConfig: chunkOverlapLines (${chunkOverlapLines}) must be below chunkLines (${chunkLines})`);
    }
    const maxArtifactBytes = positiveInt('maxArtifactBytes', config.maxArtifactBytes ?? DEFAULTS.maxArtifactBytes);
    const maxTotalBytes = positiveInt('maxTotalBytes', config.maxTotalBytes ?? DEFAULTS.maxTotalBytes);
    if (maxTotalBytes < maxArtifactBytes) {
        throw new Error(`ArtifactStoreConfig: maxTotalBytes (${maxTotalBytes}) must be at least maxArtifactBytes (${maxArtifactBytes})`);
    }
    const tenantId = config.tenantId ?? DEFAULTS.tenantId;
    // The tenant becomes a directory name, so it must not be able to escape one.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(tenantId)) {
        throw new Error(`ArtifactStoreConfig: tenantId must be 1-128 chars of [A-Za-z0-9._-], got ${JSON.stringify(tenantId)}`);
    }
    return {
        tenantId,
        root: expandHome(config.root ?? join(homedir(), '.dsh', 'artifacts')),
        durability,
        maxArtifactBytes,
        maxTotalBytes,
        retentionDays: nonNegativeInt('retentionDays', config.retentionDays ?? DEFAULTS.retentionDays),
        chunkLines,
        chunkOverlapLines,
        redactSecrets: config.redactSecrets ?? DEFAULTS.redactSecrets,
        defaultSecurityLabel: label,
        registerTools: config.registerTools ?? DEFAULTS.registerTools,
        maxToolReadBytes: positiveInt('maxToolReadBytes', config.maxToolReadBytes ?? DEFAULTS.maxToolReadBytes),
    };
}
//# sourceMappingURL=config.js.map