/**
 * Profile presets and configuration validation.
 *
 * Every check here runs at plugin load. A budget that only proves wrong under
 * pressure is a production incident scheduled for the worst possible moment.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive/config
 */
const KEYS = new Set([
    'profile', 'thresholdRatio', 'retainRatio', 'retainTokens',
    'summarizationProvider', 'summarizationModel', 'maxTokens',
    'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
    'hysteresis', 'budget', 'anchors', 'summary', 'evidence', 'sidecar', 'ownership', 'security',
]);
const SECTION_KEYS = {
    hysteresis: new Set(['releaseRatio', 'cooldownLogEvents', 'cooldownTurns', 'maxPassesPerStep', 'onBudgetExhausted']),
    budget: new Set(['minCompactTokens', 'checkpointAbsorbFloor', 'outputReserve', 'minSavingsTokens', 'maxEstimatedSummaryRequestTokens', 'maxInputTokens']),
    anchors: new Set(['enabled', 'maxTokens', 'maxShareOfShadowed', 'kinds', 'userPinMarkers', 'maxPerKind', 'maxAnchorChars']),
    summary: new Set(['mode', 'schemaVersion', 'onParseError', 'replayPrefix', 'enforceSchema', 'compactPrompt', 'compactRendering', 'foldToolRepeats', 'dedupeToolPayloads', 'repairShape', 'jsonObject', 'verbatimFileArtifacts']),
    evidence: new Set(['enabled', 'budgetRatio', 'topK', 'finalK', 'stabilityWindow']),
    sidecar: new Set(['mode', 'endpoint', 'timeoutMs', 'failOpen', 'tenantId', 'authTokenEnv']),
    ownership: new Set(['pressure', 'overflowFallback']),
    security: new Set(['localProviders']),
};
const ANCHOR_KINDS = ['errors', 'tests', 'files', 'artifacts', 'commands', 'user_pins', 'deliverables'];
/**
 * Ordered most- to least-expendable when the anchor budget runs out.
 * `deliverables` sits alongside `user_pins` at the protected end: both are
 * explicit, human-stated obligations, not incidental evidence gathered along
 * the way. Losing an errors/tests/files anchor degrades context quality;
 * losing a deliverable can silently drop a required part of the answer
 * (`summary.ts`'s `reconcileOpenDeliverables()` re-adds it to `open` even
 * when evicted here, but only the verbatim question text in the rendered
 * Anchors block — the version worth actually re-reading, not just a bare
 * label reminder — survives if it stays kept).
 */
export const ANCHOR_PRIORITY = ['commands', 'artifacts', 'files', 'tests', 'errors', 'user_pins', 'deliverables'];
const BASE = {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxTokens: 8192,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    auto: true,
    hysteresis: {
        releaseRatio: 0.6, cooldownLogEvents: 24, cooldownTurns: 1,
        maxPassesPerStep: 2, onBudgetExhausted: 'degrade',
    },
    budget: { minCompactTokens: 4096, checkpointAbsorbFloor: 0.75, minSavingsTokens: 0, maxEstimatedSummaryRequestTokens: 0 },
    anchors: {
        enabled: true, maxTokens: 1024, maxShareOfShadowed: 0.25,
        kinds: ANCHOR_KINDS, userPinMarkers: ['MUST:', 'CONSTRAINT:', '約束:', 'Correction:', 'Latest correction:', '更正:', '修正:'], maxPerKind: 24,
        maxAnchorChars: 320,
    },
    summary: {
        mode: 'structured', schemaVersion: 1, onParseError: 'fallback-prose', replayPrefix: true,
        enforceSchema: true, compactPrompt: false, compactRendering: false, foldToolRepeats: false, dedupeToolPayloads: false, repairShape: false, jsonObject: false,
    },
    sidecar: { mode: 'native', endpoint: '', timeoutMs: 20_000, failOpen: true, tenantId: 'default' },
    evidence: { enabled: true, budgetRatio: 0.2, topK: 32, finalK: 12, stabilityWindow: 3 },
    ownership: { pressure: 'harness', overflowFallback: 'summarize' },
    // Fail closed (Codex review, round 8): a provider's NAME never proves its
    // endpoint is actually local — packages/llm-llamacpp's own adapter takes
    // an arbitrary, operator-configured baseUrl, so a route named 'llamacpp'
    // pointed at a cloud-hosted endpoint would have silently qualified under
    // a non-empty default. Empty here means "every provider counts as
    // remote" unless a deployment explicitly sets its own
    // config.security.localProviders — no PROFILE grants an exception to
    // this (Codex review, round 9): a profile selects tuning numbers only,
    // never network trust. See 'local-4090' below for the fuller reasoning.
    security: { localProviders: [] },
};
export const PROFILES = {
    'cloud-l': {
        ...BASE,
        thresholdRatio: 0.72, retainRatio: 0.14, maxTokens: 8192,
        compactionRetries: 2, maxOverflowRetries: 2,
        hysteresis: { ...BASE.hysteresis, releaseRatio: 0.55, cooldownLogEvents: 32 },
        budget: { minCompactTokens: 8192, checkpointAbsorbFloor: 0.75 },
        anchors: { ...BASE.anchors, maxTokens: 2048 },
        evidence: { ...BASE.evidence, budgetRatio: 0.28, finalK: 16 },
    },
    'local-4090': {
        ...BASE,
        thresholdRatio: 0.78, retainRatio: 0.22, maxTokens: 4096,
        compactionRetries: 1, maxOverflowRetries: 1,
        hysteresis: { ...BASE.hysteresis, releaseRatio: 0.62, cooldownLogEvents: 24 },
        budget: { minCompactTokens: 4096, checkpointAbsorbFloor: 0.75, outputReserve: 12288 },
        anchors: { ...BASE.anchors, maxTokens: 768 },
        evidence: { ...BASE.evidence, budgetRatio: 0.18, finalK: 8 },
        // No security.localProviders override (Codex review, round 9): an
        // earlier version of this preset trusted ['llamacpp', 'local'] here,
        // reasoning that selecting 'local-4090' at all was itself an
        // attestation of a genuinely on-box deployment. That reasoning was
        // wrong — this profile only selects compaction TUNING numbers
        // (thresholdRatio, budget, anchors sizing for a 128K/24GB tier); it has
        // no structural link to what ctx.llm's own 'llamacpp'-named route is
        // actually configured to talk to. An operator can select this profile
        // purely for its token-budget shape while pointing that route's
        // baseUrl at a remote host — reintroducing exactly the fail-open
        // inference BASE's own empty default exists to close. Every
        // deployment, this one included, must set security.localProviders
        // explicitly; there is no profile-based shortcut.
    },
};
function ratio(name, value, exclusiveMax = 1) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= exclusiveMax) {
        throw new Error(`AdaptiveCompactionConfig: ${name} (${value}) must be between 0 and ${exclusiveMax}, exclusive`);
    }
    return value;
}
function positiveInt(name, value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`AdaptiveCompactionConfig: ${name} (${value}) must be a positive integer`);
    }
    return value;
}
/**
 * `outputReserve`'s dual-mode input: `>= 1` is an absolute token count (must
 * be an integer, like every other absolute-token field here); `[0, 1)` is a
 * fraction of contextWindow, scaled later in `resolveSpec` once that's known.
 */
function tokensOrRatio(name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`AdaptiveCompactionConfig: ${name} (${value}) must be a non-negative number`);
    }
    if (value >= 1 && !Number.isInteger(value)) {
        throw new Error(`AdaptiveCompactionConfig: ${name} (${value}) must be an integer when >= 1`);
    }
    return value;
}
/**
 * Keys that existed under a previous name, mapped to their current one.
 *
 * A renamed key already fails as "unknown", so nothing is silently ignored —
 * but the message then lists every allowed key and leaves the reader to spot
 * the near-match in it. Naming the rename turns that into a one-line fix, IF
 * the rename actually preserves the value; seeing `renameHint` is what makes
 * that conditional load-bearing.
 *
 * Entries are keyed by `section.key`, or a bare key for the top level.
 */
const RENAMED = {
    'hysteresis.cooldownGenerations': {
        to: 'hysteresis.cooldownLogEvents',
        // NOT value-preserving. The old setting counted surface.replaceGeneration
        // (one tick per successful COMPACTION); the new one counts ordinary log
        // events (one tick per APPEND) — different units, chosen specifically
        // because counting generations deadlocked the whole cooldown clock (see
        // docs/11-review-log.md R22/C5). Both of this project's own example
        // configs carried `cooldownGenerations: 2`; the CURRENT profile defaults
        // for the same setting are 24 (local-4090) and 32 (cloud-l). Telling an
        // operator to "update the key" and stopping there — what an earlier
        // version of this file did — reads as a mechanical, safe rename. Copying
        // 2 log events instead of 2 generations collapses the cooldown almost to
        // nothing: far more frequent compaction, cost, and prefix-cache churn.
        valuePreserving: false,
        units: { old: 'one tick per successful compaction', new: 'one tick per appended log event' },
    },
};
/**
 * The migration hint for a key, when it has one.
 * @param qualified - `section.key`, or a bare key at the top level.
 * @returns a complete actionable sentence, or undefined for a genuinely unknown key.
 */
function renameHint(qualified) {
    const info = RENAMED[qualified];
    if (info === undefined)
        return undefined;
    const oldName = qualified.split('.').pop();
    const newName = info.to.split('.').pop();
    if (info.valuePreserving) {
        return `"${oldName}" was renamed to "${newName}"; update the config key`;
    }
    const unitNote = info.units === undefined
        ? ''
        : ` ("${oldName}" was ${info.units.old}; "${newName}" is ${info.units.new})`;
    return `"${oldName}" was replaced by "${newName}", which counts something different and is NOT `
        + `a value-preserving rename${unitNote} — copying the old number under the new key is very `
        + `likely wrong; remove the override to use the profile default, or choose a new value for `
        + `"${newName}" appropriate to what it actually measures`;
}
function assertSectionKeys(section, value) {
    if (value === undefined)
        return;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`AdaptiveCompactionConfig: ${section} must be an object`);
    }
    const allowed = SECTION_KEYS[section];
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            const hint = renameHint(`${section}.${key}`);
            throw new Error(hint === undefined
                ? `AdaptiveCompactionConfig: ${section}: unknown key "${key}" (allowed: ${[...allowed].join(', ')})`
                : `AdaptiveCompactionConfig: ${section}: ${hint}`);
        }
    }
}
/**
 * Resolve a configuration: expand the profile, apply explicit overrides, validate.
 * @param config - raw plugin configuration.
 * @returns the resolved configuration.
 * @throws on unknown keys or an unsatisfiable budget.
 */
export function resolveAdaptiveConfig(config = {}) {
    for (const key of Object.keys(config)) {
        if (!KEYS.has(key)) {
            const hint = renameHint(key);
            throw new Error(hint === undefined
                ? `AdaptiveCompactionConfig: unknown key "${key}" (allowed: ${[...KEYS].join(', ')})`
                : `AdaptiveCompactionConfig: ${hint}`);
        }
    }
    for (const section of Object.keys(SECTION_KEYS)) {
        assertSectionKeys(section, config[section]);
    }
    const profile = config.profile ?? 'cloud-l';
    if (profile !== 'custom' && PROFILES[profile] === undefined) {
        throw new Error(`AdaptiveCompactionConfig: profile must be one of ${Object.keys(PROFILES).join(', ')}, custom`);
    }
    const preset = profile === 'custom' ? BASE : PROFILES[profile];
    if (config.retainRatio !== undefined && config.retainTokens !== undefined) {
        throw new Error('AdaptiveCompactionConfig: retainRatio and retainTokens are mutually exclusive');
    }
    const thresholdRatio = ratio('thresholdRatio', config.thresholdRatio ?? preset.thresholdRatio);
    const releaseRatio = ratio('hysteresis.releaseRatio', config.hysteresis?.releaseRatio ?? preset.hysteresis.releaseRatio);
    // The hysteresis band is what stops a session from recompacting on the very
    // next step. A partial override — lowering thresholdRatio while inheriting a
    // profile's releaseRatio — is the realistic way to lose it, so the error names
    // both fields and the fix. Rescaling silently would hide a genuine mistake.
    if (releaseRatio >= thresholdRatio) {
        throw new Error(`AdaptiveCompactionConfig: hysteresis.releaseRatio (${releaseRatio}) must be below `
            + `thresholdRatio (${thresholdRatio}); the gap between them is the hysteresis band. `
            + `Set hysteresis.releaseRatio explicitly when overriding thresholdRatio`
            + `${config.profile === undefined ? '' : ` (profile "${profile}" supplies ${preset.hysteresis.releaseRatio})`}.`);
    }
    const retainRatio = config.retainTokens !== undefined
        ? undefined
        : ratio('retainRatio', config.retainRatio ?? preset.retainRatio ?? BASE.retainRatio);
    if (retainRatio !== undefined && retainRatio >= thresholdRatio) {
        throw new Error(`AdaptiveCompactionConfig: retainRatio (${retainRatio}) must be below thresholdRatio (${thresholdRatio})`);
    }
    const anchors = {
        enabled: config.anchors?.enabled ?? preset.anchors.enabled,
        maxTokens: positiveInt('anchors.maxTokens', config.anchors?.maxTokens ?? preset.anchors.maxTokens),
        maxShareOfShadowed: ratio('anchors.maxShareOfShadowed', config.anchors?.maxShareOfShadowed ?? preset.anchors.maxShareOfShadowed),
        kinds: validateKinds(config.anchors?.kinds ?? preset.anchors.kinds),
        userPinMarkers: config.anchors?.userPinMarkers ?? preset.anchors.userPinMarkers,
        maxPerKind: positiveInt('anchors.maxPerKind', config.anchors?.maxPerKind ?? preset.anchors.maxPerKind),
        maxAnchorChars: positiveInt('anchors.maxAnchorChars', config.anchors?.maxAnchorChars ?? preset.anchors.maxAnchorChars),
    };
    for (const key of ['compactPrompt', 'compactRendering', 'foldToolRepeats', 'dedupeToolPayloads', 'repairShape', 'jsonObject', 'verbatimFileArtifacts']) {
        if (config.summary?.[key] !== undefined && typeof config.summary[key] !== 'boolean')
            throw new Error(`AdaptiveCompactionConfig: summary.${key} must be boolean`);
    }
    const summaryMode = config.summary?.mode ?? preset.summary.mode;
    if (!['structured', 'prose', 'flat'].includes(summaryMode)) {
        throw new Error(`AdaptiveCompactionConfig: summary.mode must be "structured", "prose", or "flat"`);
    }
    const onParseError = config.summary?.onParseError ?? preset.summary.onParseError;
    if (!['fallback-prose', 'retry-once', 'fail'].includes(onParseError)) {
        throw new Error('AdaptiveCompactionConfig: summary.onParseError must be one of fallback-prose, retry-once, fail');
    }
    const pressure = config.ownership?.pressure ?? preset.ownership.pressure;
    const overflowFallback = config.ownership?.overflowFallback ?? preset.ownership.overflowFallback;
    if (pressure !== 'harness' && pressure !== 'provider') {
        throw new Error('AdaptiveCompactionConfig: ownership.pressure must be "harness" or "provider"');
    }
    if (overflowFallback !== 'summarize' && overflowFallback !== 'prune-only') {
        throw new Error('AdaptiveCompactionConfig: ownership.overflowFallback must be "summarize" or "prune-only"');
    }
    const sidecarMode = config.sidecar?.mode ?? preset.sidecar.mode;
    if (!['native', 'rest', 'grpc'].includes(sidecarMode)) {
        throw new Error('AdaptiveCompactionConfig: sidecar.mode must be one of native, rest, grpc');
    }
    const sidecarEndpoint = config.sidecar?.endpoint ?? preset.sidecar.endpoint;
    if (sidecarMode !== 'native' && sidecarEndpoint.length === 0) {
        throw new Error(`AdaptiveCompactionConfig: sidecar.endpoint is required when sidecar.mode is "${sidecarMode}"`);
    }
    const sidecarAuthTokenEnv = config.sidecar?.authTokenEnv ?? preset.sidecar.authTokenEnv;
    // docs/05-sidecar-protocol.md §3.2/§4 mark bearer auth mandatory on every
    // endpoint — an omitted authTokenEnv is not "auth not needed", it is
    // every request going out unauthenticated, which a conforming, schema-
    // validating sidecar rejects on every single pass (Codex review): with
    // failOpen this silently invokes the native summarizer instead every
    // time, and without it compaction fails every time — either way, a
    // REST sidecar an operator believes is running never actually is. Fail
    // at load, the same as a missing endpoint, rather than discover this
    // only once real traffic starts arriving unauthenticated. Only the
    // env-var NAME is checked here (config-shape validation); the actual
    // env var VALUE is checked in the constructor, where process.env is
    // already read.
    if (sidecarMode === 'rest' && (sidecarAuthTokenEnv === undefined || sidecarAuthTokenEnv.length === 0)) {
        throw new Error('AdaptiveCompactionConfig: sidecar.authTokenEnv is required when sidecar.mode is "rest" — '
            + 'docs/05-sidecar-protocol.md marks bearer auth mandatory on every endpoint');
    }
    const sidecar = {
        mode: sidecarMode,
        endpoint: sidecarEndpoint,
        timeoutMs: positiveInt('sidecar.timeoutMs', config.sidecar?.timeoutMs ?? preset.sidecar.timeoutMs),
        failOpen: config.sidecar?.failOpen ?? preset.sidecar.failOpen,
        tenantId: config.sidecar?.tenantId ?? preset.sidecar.tenantId,
        // Conditional spread: exactOptionalPropertyTypes treats an explicit
        // undefined as a different thing from an absent key, and there is no
        // sensible always-present default for an env-var name (unlike
        // endpoint's '' sentinel) to fall back to. Already validated above
        // (non-empty, required) whenever mode is 'rest'.
        ...(sidecarAuthTokenEnv === undefined ? {} : { authTokenEnv: sidecarAuthTokenEnv }),
    };
    const onBudgetExhausted = config.hysteresis?.onBudgetExhausted ?? preset.hysteresis.onBudgetExhausted;
    if (onBudgetExhausted !== 'degrade' && onBudgetExhausted !== 'throw') {
        throw new Error('AdaptiveCompactionConfig: hysteresis.onBudgetExhausted must be "degrade" or "throw"');
    }
    return {
        profile,
        thresholdRatio,
        ...(retainRatio === undefined ? {} : { retainRatio }),
        ...(config.retainTokens === undefined
            ? {} : { retainTokens: positiveInt('retainTokens', config.retainTokens) }),
        maxTokens: positiveInt('maxTokens', config.maxTokens ?? preset.maxTokens),
        compactionRetries: nonNegativeInt('compactionRetries', config.compactionRetries ?? preset.compactionRetries),
        maxOverflowRetries: nonNegativeInt('maxOverflowRetries', config.maxOverflowRetries ?? preset.maxOverflowRetries),
        auto: config.auto ?? preset.auto,
        hysteresis: {
            releaseRatio,
            cooldownLogEvents: nonNegativeInt('hysteresis.cooldownLogEvents', config.hysteresis?.cooldownLogEvents ?? preset.hysteresis.cooldownLogEvents),
            cooldownTurns: nonNegativeInt('hysteresis.cooldownTurns', config.hysteresis?.cooldownTurns ?? preset.hysteresis.cooldownTurns),
            maxPassesPerStep: positiveInt('hysteresis.maxPassesPerStep', config.hysteresis?.maxPassesPerStep ?? preset.hysteresis.maxPassesPerStep),
            onBudgetExhausted,
        },
        budget: {
            minCompactTokens: nonNegativeInt('budget.minCompactTokens', config.budget?.minCompactTokens ?? preset.budget.minCompactTokens),
            minSavingsTokens: nonNegativeInt('budget.minSavingsTokens', config.budget?.minSavingsTokens ?? preset.budget.minSavingsTokens ?? 0),
            maxEstimatedSummaryRequestTokens: nonNegativeInt('budget.maxEstimatedSummaryRequestTokens', config.budget?.maxEstimatedSummaryRequestTokens ?? preset.budget.maxEstimatedSummaryRequestTokens ?? 0),
            maxInputTokens: nonNegativeInt('budget.maxInputTokens', config.budget?.maxInputTokens ?? 0),
            checkpointAbsorbFloor: ratio('budget.checkpointAbsorbFloor', config.budget?.checkpointAbsorbFloor ?? preset.budget.checkpointAbsorbFloor, 1.0001),
            ...((config.budget?.outputReserve ?? preset.budget.outputReserve) === undefined ? {} : {
                outputReserve: tokensOrRatio('budget.outputReserve', config.budget?.outputReserve ?? preset.budget.outputReserve),
            }),
        },
        anchors,
        summary: {
            mode: summaryMode,
            schemaVersion: positiveInt('summary.schemaVersion', config.summary?.schemaVersion ?? preset.summary.schemaVersion),
            onParseError,
            replayPrefix: config.summary?.replayPrefix ?? preset.summary.replayPrefix,
            enforceSchema: config.summary?.enforceSchema ?? preset.summary.enforceSchema,
            compactPrompt: config.summary?.compactPrompt ?? preset.summary.compactPrompt,
            compactRendering: config.summary?.compactRendering ?? preset.summary.compactRendering,
            foldToolRepeats: config.summary?.foldToolRepeats ?? preset.summary.foldToolRepeats,
            dedupeToolPayloads: config.summary?.dedupeToolPayloads ?? false,
            repairShape: config.summary?.repairShape ?? preset.summary.repairShape,
            jsonObject: config.summary?.jsonObject ?? preset.summary.jsonObject,
            verbatimFileArtifacts: config.summary?.verbatimFileArtifacts ?? false,
        },
        evidence: {
            enabled: config.evidence?.enabled ?? preset.evidence.enabled,
            budgetRatio: ratio('evidence.budgetRatio', config.evidence?.budgetRatio ?? preset.evidence.budgetRatio),
            topK: positiveInt('evidence.topK', config.evidence?.topK ?? preset.evidence.topK),
            finalK: positiveInt('evidence.finalK', config.evidence?.finalK ?? preset.evidence.finalK),
            stabilityWindow: nonNegativeInt('evidence.stabilityWindow', config.evidence?.stabilityWindow ?? preset.evidence.stabilityWindow),
        },
        sidecar,
        ownership: { pressure, overflowFallback },
        security: {
            localProviders: validateLocalProviders(config.security?.localProviders ?? preset.security.localProviders),
        },
    };
}
function nonNegativeInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`AdaptiveCompactionConfig: ${name} (${value}) must be a non-negative integer`);
    }
    return value;
}
function validateKinds(kinds) {
    for (const kind of kinds) {
        if (!ANCHOR_KINDS.includes(kind)) {
            throw new Error(`AdaptiveCompactionConfig: anchors.kinds contains unknown kind "${kind}" `
                + `(allowed: ${ANCHOR_KINDS.join(', ')})`);
        }
    }
    return [...kinds];
}
/** Empty is valid — "treat every provider as remote" is a legitimate config. */
function validateLocalProviders(providers) {
    if (!Array.isArray(providers) || providers.some(p => typeof p !== 'string' || p.length === 0)) {
        throw new Error('AdaptiveCompactionConfig: security.localProviders must be an array of non-empty strings');
    }
    return [...providers];
}
/** An explicit `outputReserve` config value, scaled like `retainTokens`/`retainRatio`. */
function scaleOutputReserve(value, contextWindow) {
    return value < 1 ? Math.floor(contextWindow * value) : value;
}
/**
 * Derive `outputReserve` from model capability when it isn't configured
 * explicitly: `min(maxOutputTokens, max(0.05 * window, maxTokens * 2))`
 * (docs/03-packages.md's `budget.outputReserve` spec).
 *
 * No upstream type actually exposes a `maxOutputTokens` ceiling (verified:
 * no such field exists anywhere in `@deepseek-ai/dsh-llm`'s types) — the
 * closest real, populated signal is `LlmResolvedModelInfo.defaultMaxTokens`,
 * the adapter's own configured default for a request's `max_tokens`. It's an
 * imperfect stand-in, not a true ceiling, but it's what's actually available.
 * When it's unknown the `min(...)` clamp is skipped entirely rather than
 * treated as a ceiling of zero, so an uncharacterized model still gets the
 * full capability-independent floor.
 */
function deriveOutputReserve(contextWindow, maxTokens, defaultMaxTokens) {
    const floor = Math.max(contextWindow * 0.05, maxTokens * 2);
    return Math.floor(defaultMaxTokens === undefined ? floor : Math.min(defaultMaxTokens, floor));
}
/**
 * Scale a resolved policy into concrete token budgets for one model.
 * @param config - resolved configuration.
 * @param contextWindow - the routed model's context capacity.
 * @param defaultMaxTokens - the routed model's `defaultMaxTokens`, when known;
 * see `deriveOutputReserve` for why this stands in for a true output ceiling.
 */
export function resolveSpec(config, contextWindow, defaultMaxTokens, requestedMaxTokens) {
    const retainTokens = config.retainTokens
        ?? Math.floor(contextWindow * (config.retainRatio ?? BASE.retainRatio));
    const configuredThreshold = Math.floor(contextWindow * config.thresholdRatio);
    const configuredReserve = config.budget.outputReserve === undefined
        ? deriveOutputReserve(contextWindow, config.maxTokens, defaultMaxTokens)
        : scaleOutputReserve(config.budget.outputReserve, contextWindow);
    const outputReserve = Math.max(configuredReserve, requestedMaxTokens ?? 0);
    // This is an input-only adapter ceiling; output reserve is already applied
    // to the model window. Zero leaves existing deployments unchanged.
    const usableInputTokens = Math.min(contextWindow - outputReserve,
        config.budget.maxInputTokens > 0 ? config.budget.maxInputTokens : Infinity);
    const thresholdTokens = Math.min(configuredThreshold, usableInputTokens);
    if (retainTokens >= thresholdTokens) {
        // Only checkable once capacity is known, so it surfaces on the first
        // resolvable target rather than at load.
        throw new Error(`AdaptiveCompactionConfig: retainTokens (${retainTokens}) must be below the scaled `
            + `threshold (${thresholdTokens}) for a ${contextWindow}-token window`);
    }
    if (outputReserve >= contextWindow) {
        // Same reasoning as the retainTokens check above: an absolute override
        // (or, on a small enough window, even the capability-derived floor) can
        // exceed the window itself, which would hand a negative or zero usable
        // budget to any consumer doing contextWindow - outputReserve.
        throw new Error(`AdaptiveCompactionConfig: outputReserve (${outputReserve}) must be below the `
            + `${contextWindow}-token window`);
    }
    return {
        contextWindow,
        thresholdTokens,
        releaseTokens: thresholdTokens === configuredThreshold
            ? Math.floor(contextWindow * config.hysteresis.releaseRatio)
            : Math.floor(thresholdTokens * config.hysteresis.releaseRatio / config.thresholdRatio),
        usableInputTokens,
        retainTokens,
        minCompactTokens: config.budget.minCompactTokens,
        checkpointAbsorbFloor: config.budget.checkpointAbsorbFloor,
        outputReserve,
        maxPassesPerStep: config.hysteresis.maxPassesPerStep,
        cooldownLogEvents: config.hysteresis.cooldownLogEvents,
        cooldownTurns: config.hysteresis.cooldownTurns,
    };
}
//# sourceMappingURL=config.js.map
