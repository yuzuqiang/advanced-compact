/**
 * Adaptive compaction backend (`ctx.compaction`).
 *
 * Extends the shipped `BasicCompactionEngine` rather than replacing it. The
 * durable transaction — the log-recorded lock, tool-pairing validation, shrink
 * validation, surface-generation CAS, the guarantee that a failed attempt still
 * closes its bracket — is upstream's, is subtle, and is exactly the code a
 * plugin should not reimplement. Three seams are overridden:
 *
 *   compactIfNeeded()  when to compact, and which span
 *   summarize()        what the checkpoint says
 *   compactNow()       manual compaction, with the pruner properly admitted
 *
 * plus `compactRegion()`, solely to remember which seqs are being shadowed.
 *
 * Load INSTEAD OF `@deepseek-ai/dsh-compaction-basic`: both claim
 * `ctx.compaction`, and a context holds one.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate';
import z from '@deepseek-ai/schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
// Also resolves the optional sibling services for `ctx.get()`.
import { findArtifactUris } from '@adaptive-compact/dsh-artifact-store';
import { ANCHORS_BLOCK_HEADING, coalescedBlockText, extractAnchors, alignSeqsToMessages, findMissingAnchors, isDeliveredAnswer, isTruncated, neutralizeAnchorImpersonation, renderAnchors, renderOverflow, unmentionedDeliverableNotes, } from "./anchors.js";
import { resolveAdaptiveConfig, resolveSpec } from "./config.js";
import { summarySha256 } from "./jcs.js";
import { cooldownPassed, currentStep, currentTurn, markOf, passBudget, shouldCompact, } from "./policy.js";
import { selectAdaptiveRange } from "./range.js";
import { redactText } from '@adaptive-compact/dsh-artifact-store/redact';
import { SidecarChangedError, SidecarClient, SidecarRejectedError } from "./sidecar-client.js";
import { fromWireContentBlocks, toSurfaceNode } from "./sidecar-serialize.js";
import { flatSummaryInstruction, flatSummaryJsonSchema, parseFlatSummaryDocument } from "./flat-summary.js";
import { foldToolRepeats, toolResultContent, dedupeToolPayloads, TOOL_PAYLOAD_REFERENCE_RULE } from "./prompt.js";
const REGION_SIGNAL = Symbol('adaptive-compaction-region-signal');
import { CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG, groundFileArtifacts, repairSummaryDocumentShape, hasSummaryDocumentContent, compactCompactionInstruction, compactionInstruction, parseSummaryDocument, renderSummary, scrubUnresolvableUris, summaryDocumentJsonSchema, UNRESOLVABLE, } from "./summary.js";
export * from "./anchors.js";
export * from "./jcs.js";
export * from "./policy.js";
export * from "./range.js";
export * from "./summary.js";
export * from "./webhook.js";
export { ANCHOR_PRIORITY, PROFILES, resolveAdaptiveConfig, resolveSpec } from "./config.js";
/** The routed provider/model, or undefined before the first request. */
function routedTarget(session) {
    const config = session.requestHeader()?.config;
    if (config === undefined || config.provider.length === 0 || config.model.length === 0)
        return undefined;
    return { provider: config.provider, model: config.model };
}
/**
 * A fixed, constant-size sentinel marking a checkpoint as derived from
 * secret-labelled content (SEC-06). Deliberately not a list of the actual
 * artifact URIs — see `AdaptiveCompactionEngine.withSecretProvenance()`'s
 * own doc comment for why (Codex review round 4: bounded size, and outlives
 * the artifact references it would otherwise cite).
 */
const SECRET_PROVENANCE_MARKER = '<!-- secret-provenance: true -->';
export class AdaptiveCompactionEngine extends BasicCompactionEngine {
    static inject = ['llm', 'tokenMeter', 'sessions'];
    static Config = z.object({
        profile: z.string(),
        thresholdRatio: z.number(),
        retainRatio: z.number(),
        retainTokens: z.number().step(1).min(0),
        summarizationProvider: z.string(),
        summarizationModel: z.string(),
        maxTokens: z.number().step(1).min(1),
        compactionRetries: z.number().step(1).min(0),
        maxOverflowRetries: z.number().step(1).min(0),
        auto: z.boolean(),
        hysteresis: z.object({}),
        budget: z.object({}),
        sidecar: z.object({}),
        anchors: z.object({}),
        summary: z.object({}),
        evidence: z.object({}),
        ownership: z.object({}),
        security: z.object({}),
    });
    adaptive;
    stats = {
        considered: 0, compacted: 0, skippedCooldown: 0, skippedNoRange: 0,
        prunedOnly: 0, budgetExhausted: 0, parseFailures: 0, proseFallbacks: 0, shapeRepairs: 0,
        /** Passes that opened a bracket and committed nothing. See `passFailed`. */
        passFailures: 0,
        /**
         * Summarizations downgraded to the zero-model-call anchors-only path
         * because the context being compacted carried secret-labelled content
         * and the resolved summarization target was not in
         * `security.localProviders` (SEC-06). Paired with a `ctx.logger.warn()`
         * call whose message is grep-able as `context.summary_downgraded_secret`
         * — see docs/07-security.md §3/§6.
         */
        secretDowngrades: 0,
        /** Every attempted sidecar `/v1/compact` call, successful or not. */
        sidecarCalls: 0,
        lowSavingsRejected: 0, skippedRepeatedLowSavings: 0, summaryBudgetRejected: 0, infeasibleBudgets: 0,
        /**
         * Sidecar failures recovered via `nativeFallback()` (timeout, network
         * error, non-409 HTTP failure, malformed response, a sha256 mismatch,
         * or a missing anchor) — every failOpen-eligible reason, all counted
         * together; the specific reason is in the paired `ctx.logger.warn()`
         * line, grep-able as `context.sidecar_call_failed` or, for the sha256
         * case specifically, `security.sidecar_response_rejected`.
         */
        sidecarFailOpens: 0,
        /**
         * CAS/409 hard failures (INT-17) — the surface generation changed
         * between request and response. Never recovered via failOpen; always
         * propagates. Grep-able as `context.sidecar_response_changed`.
         */
        sidecarChanged: 0,
    };
    /** One bounded fingerprint/count per live session; never retained history. */
    lowSavingsRepeats = new WeakMap();
    lastCompaction = new WeakMap();
    passes = new WeakMap();
    pendingShadowed = new WeakMap();
    /**
     * `RegionDependencies.summarize()` has no `trigger` parameter (confirmed
     * against `@deepseek-ai/dsh-compaction-basic`'s own types) — but the wire
     * `CompactRequest.trigger` is required, so it is stashed here before
     * delegating, the same pattern `pendingShadowed` above already
     * establishes for provenance. Set one level higher than `pendingShadowed`
     * (in `compactIfNeeded()`/`compactNow()` themselves, not
     * `compactRegion()`), since that is where `trigger` is actually known.
     * Never explicitly cleared: every path that could reach `summarize()`
     * unconditionally sets its own fresh value first, unlike
     * `pendingShadowed`'s provenance-misattribution risk.
     */
    pendingTrigger = new WeakMap();
    sidecarClient;
    constructor(ctx, config = {}) {
        const adaptive = resolveAdaptiveConfig(config);
        // Both validated BEFORE super() — deliberately (Codex review, PR #18
        // round 3): super() registers this engine's compaction service and
        // listeners on `ctx` as a side effect of running; neither of these
        // checks depends on anything `super()` sets up (only on `adaptive`/
        // `process.env`, computed above), so there is no reason to pay that
        // registration cost first only to throw it away. A construction
        // attempt that throws AFTER super() leaves `ctx` holding a stale
        // registration from the failed instance — if a caller catches the
        // error, fixes the environment, and retries construction on the SAME
        // ctx (a plugin loader's own reload path, for one), the retry's own
        // super() call can then fail as already-registered even though the
        // actual problem was already fixed.
        if (adaptive.sidecar.mode === 'grpc') {
            // The configuration contract is real and validated; no proto tooling
            // exists in this repo and none of the currently-implemented sidecar
            // scenarios need gRPC specifically (they are transport-agnostic
            // behavioral contracts) — refusing at load beats silently
            // summarizing in-process while an operator believes work is going to
            // their sidecar.
            throw new Error(`AdaptiveCompactionConfig: sidecar.mode "grpc" is not implemented yet; `
                + 'use "native" or "rest" in this version');
        }
        const authToken = adaptive.sidecar.authTokenEnv === undefined
            ? undefined : process.env[adaptive.sidecar.authTokenEnv];
        // resolveAdaptiveConfig() already guarantees authTokenEnv is a
        // non-empty NAME whenever mode is 'rest' — this is the second layer,
        // checking the actual VALUE that name resolves to in this process'
        // own environment right now. A configured-but-unset env var would
        // otherwise silently produce the exact same unauthenticated-request
        // failure mode the config-time check above exists to prevent, just
        // discovered at runtime instead of at load (Codex review).
        if (adaptive.sidecar.mode === 'rest' && (authToken === undefined || authToken.length === 0)) {
            throw new Error(`AdaptiveCompactionConfig: sidecar.authTokenEnv names "${adaptive.sidecar.authTokenEnv}", `
                + `but process.env.${adaptive.sidecar.authTokenEnv} is not set — docs/05-sidecar-protocol.md `
                + 'marks bearer auth mandatory on every endpoint');
        }
        // Hand the parent only the keys it owns, already expanded from the profile,
        // so its own validation sees the same numbers this engine will use.
        super(ctx, {
            thresholdRatio: adaptive.thresholdRatio,
            // Exactly one retention form reaches the parent. The resolver guarantees
            // retainRatio is set whenever retainTokens is not, but the two fields are
            // independent in the type, so the correlation is asserted here rather
            // than left for TypeScript to fail to infer.
            ...(adaptive.retainTokens === undefined
                ? { retainRatio: adaptive.retainRatio ?? DEFAULT_RETAIN_RATIO }
                : { retainTokens: adaptive.retainTokens }),
            ...(config.summarizationProvider === undefined
                ? {} : { summarizationProvider: config.summarizationProvider }),
            ...(config.summarizationModel === undefined
                ? {} : { summarizationModel: config.summarizationModel }),
            maxTokens: adaptive.maxTokens,
            compactionRetries: adaptive.compactionRetries,
            maxOverflowRetries: adaptive.maxOverflowRetries,
            ...(config.modelPolicies === undefined ? {} : { modelPolicies: config.modelPolicies }),
            auto: adaptive.auto,
        });
        this.adaptive = adaptive;
        this.sidecarClient = adaptive.sidecar.mode === 'rest'
            ? new SidecarClient({
                endpoint: adaptive.sidecar.endpoint,
                timeoutMs: adaptive.sidecar.timeoutMs,
                // exactOptionalPropertyTypes: an env var named by authTokenEnv but
                // not actually set at process start must omit the key entirely,
                // not set it to an explicit undefined — the env var's own
                // presence/absence is a second layer of optionality beyond
                // whether authTokenEnv was configured at all.
                ...(authToken === undefined ? {} : { authToken }),
            })
            : undefined;
    }
    // ── when to compact ──────────────────────────────────────────────────────
    /**
     * Decide whether to compact, and drive as many passes as the budget allows.
     *
     * @param agent - the agent whose session is under pressure.
     * @param trigger - step-boundary pressure, or provider-confirmed overflow.
     * @param signal - cancellation, forwarded to summarization.
     * @returns the last successful compaction, or null when none ran.
     */
    async compactIfNeeded(agent, trigger, signal) {
        // Cancellation first, before any measurement or model call. Two reasons:
        // an already-cancelled turn should not pay for work nobody will read, and
        // `throwIfAborted()` throws `signal.reason` ITSELF — the caller's own error
        // object. Discovering the abort further down means it surfaces from the
        // adapter instead, where `dsh-llm` normalizes any non-HarnessError into a
        // fresh `Error` with code `UNKNOWN`: the message survives, the identity and
        // the cause do not. UT-23 pins the difference.
        signal.throwIfAborted();
        const session = agent.session;
        const target = routedTarget(session);
        if (target === undefined)
            return null;
        this.stats.considered += 1;
        // Wire vocabulary (docs/05-sidecar-protocol.md §4) uses an underscore;
        // upstream's own CompactionTrigger uses a hyphen — no 'manual' value
        // exists there at all, since compactNow() below never goes through
        // compactIfNeeded() and stashes its own value directly. Setting
        // pendingTrigger is deferred to immediately before each compactRegion()
        // call below (not here) — see the comment there for why.
        const sidecarTrigger = trigger === 'context-overflow' ? 'context_overflow' : 'pressure';
        // Overflow takes the short path: the provider has already established that
        // the request does not fit, so neither the threshold nor the cooldown has
        // anything left to say.
        if (trigger === 'context-overflow') {
            if (this.adaptive.ownership.overflowFallback === 'prune-only') {
                // An explicit, informed choice: the provider is expected to recover on
                // its own. It is not the default, because a provider whose native
                // compaction just failed to prevent an overflow has not earned that trust.
                return this.pruneOnly(session);
            }
            // Unlike the pressure path below, this delegates the entire pass to
            // upstream's own compactIfNeeded() in one call — there is no while
            // loop here of ours to set pendingTrigger freshly before each of
            // upstream's own (out-of-our-control) internal compactRegion() calls.
            // Set immediately before the one call site we do have, same as
            // before finding 6's fix; the narrower race window that fix achieves
            // for the pressure path below is not reachable here.
            this.pendingTrigger.set(session, sidecarTrigger);
            return super.compactIfNeeded(agent, trigger, signal);
        }
        // Pressure only: with `ownership.pressure: 'provider'`, the provider's own
        // compaction owns this path and ours would be a second, competing rewrite.
        if (this.adaptive.ownership.pressure === 'provider') {
            return this.pruneOnly(session);
        }
        const meter = this.ctx.tokenMeter;
        let measurement = meter.measure(session);
        const spec = await this.specFor(agent, target, signal);
        signal.throwIfAborted(); // model resolution is async; cancellation must precede any pruning
        if (spec === null)
            return null;
        if (!shouldCompact(measurement.totalTokens, spec))
            return null;
        const fixedTokens = estimateToolsTokens(session.requestHeader()) + measurement.nodes
            .filter(node => session.eventAt(node.seq)?.type === 'system/message')
            .reduce((total, node) => total + node.tokens, 0);
        if (fixedTokens >= spec.usableInputTokens) {
            this.stats.infeasibleBudgets += 1;
            const error = new Error('adaptive compaction: fixed system/tools exceed the available input budget; summarizing cannot solve it');
            error.code = 'COMPACTION_BUDGET_INFEASIBLE';
            throw error;
        }
        const turn = currentTurn(session);
        if (!cooldownPassed(this.lastCompaction.get(session), markOf(session, measurement, turn), spec)) {
            this.stats.skippedCooldown += 1;
            return null;
        }
        // Deterministic reduction first: it is reversible (the bytes are in the
        // artifact store), costs no model call, and often removes the need for one.
        if (this.reduce(session, 'before summarizing') > 0)
            measurement = meter.measure(session);
        if (!shouldCompact(measurement.totalTokens, spec, { inProgress: true })) {
            this.noteCompacted(session, measurement, turn);
            this.stats.prunedOnly += 1;
            return null;
        }
        // Summarization passes, bounded per step.
        const step = currentStep(session);
        const state = this.passStateFor(session, turn, step);
        let budget = passBudget(state, spec);
        let result = null;
        while (budget > 0) {
            const range = selectAdaptiveRange(session, measurement, spec);
            if (range === null) {
                if (result === null)
                    this.stats.skippedNoRange += 1;
                break;
            }
            const repeatKey = this.lowSavingsRepeatKey(agent, range, measurement, spec, turn);
            const previousRepeat = this.lowSavingsRepeats.get(session);
            if (repeatKey !== undefined && previousRepeat?.key === repeatKey && previousRepeat.failures >= 2) {
                this.stats.skippedRepeatedLowSavings += 1;
                break;
            }
            // Set fresh, immediately before the call that consumes it (read inside
            // summarize(), reached synchronously from here with no intervening
            // await) — not once, earlier, before measurement/cooldown/etc. above.
            // Codex review, PR #18 finding 6: a concurrent compactNow() can set
            // pendingTrigger to 'manual' for the SAME session at any point during
            // this method's own earlier synchronous-then-async work (measurement,
            // specFor()'s own await, cooldown), which would otherwise survive to
            // be misread here as this pass's trigger even though this pass was
            // never manual. Re-set on every loop iteration, not just once before
            // the loop, since each pass itself awaits compactRegion() and a
            // concurrent manual call could land between two passes.
            this.pendingTrigger.set(session, sidecarTrigger);
            // A failed attempt also consumes quota and the per-step allowance.
            this.recordPass(session, turn, step);
            budget -= 1;
            try {
                result = await this.compactRegion(range.start, range.end, agent, signal);
            }
            catch (error) {
                // A later pass can legitimately fail — upstream rejects a summary that
                // is not smaller than the span it replaces, and once the remaining span
                // approaches one checkpoint's size that becomes likely. Throwing here
                // would discard an earlier pass that already committed, so the failure
                // is recorded and the successful reduction is returned. Cancellation
                // still wins: it means the turn is over, not that a pass was unlucky.
                if (signal.aborted)
                    throw error;
                // Only this economic rejection counts, never parse/transport/shrink
                // errors. The captured key belongs to this attempt, even if another
                // caller changed session-keyed staging while its provider awaited.
                if (repeatKey !== undefined && error?.code === 'COMPACTION_LOW_SAVINGS') {
                    this.lowSavingsRepeats.set(session, { key: repeatKey,
                        failures: Math.min(2, (previousRepeat?.key === repeatKey ? previousRepeat.failures : 0) + 1) });
                }
                else if (error?.code !== 'busy') {
                    this.lowSavingsRepeats.delete(session);
                }
                this.stats.passFailures += 1;
                this.ctx.logger.warn(`adaptive compaction: pass failed (${String(error)}); `
                    + `${result === null ? 'no reduction was committed' : 'keeping the earlier reduction'}`);
                // Back off exactly as a SUCCESSFUL compaction does.
                //
                // Without this, a compaction that cannot shrink — the shrink check
                // rejects a framed summary that is not smaller than the span it
                // replaces, which becomes likely once the span approaches one
                // checkpoint's size — re-attempts on EVERY step, because the cooldown
                // was only ever recorded on success. Each attempt is a full
                // summarization call, so the loop is expensive and invisible: measured
                // on E2E-01, seven consecutive failed transactions took 165s against
                // 29s for the same task, with `compacted: 0` the whole way. That is the
                // compaction loop hysteresis exists to prevent, reached through the
                // failure path instead of the success path.
                //
                // The mark is a backoff, not a permanent block: once the cooldown
                // elapses and the surface has moved on, the next attempt proceeds.
                // Do not let this failed transaction count as new task progress.
                this.noteCompacted(session, meter.measure(session), turn);
                if (result === null)
                    throw error;
                break;
            }
            this.lowSavingsRepeats.delete(session);
            this.stats.compacted += 1;
            measurement = meter.measure(session);
            if (!shouldCompact(measurement.totalTokens, spec, { inProgress: true })) {
                this.noteCompacted(session, measurement, turn);
                return result;
            }
        }
        if (result !== null)
            this.noteCompacted(session, measurement, turn);
        if (measurement.totalTokens >= spec.releaseTokens) {
            this.stats.budgetExhausted += 1;
            const detail = `${measurement.totalTokens} estimated tokens is still at or above the `
                + `release budget (${spec.releaseTokens}) after ${spec.maxPassesPerStep} pass(es)`;
            if (this.adaptive.hysteresis.onBudgetExhausted === 'throw') {
                throw new Error(`adaptive compaction: ${detail}`);
            }
            // Degrading beats throwing: upstream's own pressure listener catches and
            // continues anyway, so an exception here buys nothing and loses the turn's
            // progress. Recording it makes the degraded state visible instead.
            this.ctx.logger.warn(`adaptive compaction: ${detail}; continuing the turn with an over-budget context`);
        }
        return result;
    }
    /**
     * Pressure-only economic retry identity. Content alone misses request tools,
     * routing/policy changes, and answers retained outside the selected prefix.
     * Turn and replacement generation provide explicit recovery boundaries;
     * ordinary tail tool progress and transaction bookkeeping do not change it.
     * Unversioned artifact/sidecar state is deliberately outside this guard.
     */
    lowSavingsRepeatKey(agent, range, measurement, spec, turn) {
        if (this.adaptive.budget.minSavingsTokens <= 0
            || this.adaptive.sidecar.mode !== 'native'
            || this.ctx.get('artifactStore') !== undefined)
            return undefined;
        const session = agent.session;
        const nodes = session.surface.nodes;
        const from = nodes.indexOf(range.start), to = nodes.indexOf(range.end);
        if (from < 0 || to < from)
            return undefined;
        try {
            const selected = nodes.slice(from, to + 1);
            const tail = alignSeqsToMessages(session, nodes.slice(to + 1))
                .filter(node => (node.message.role === 'user' && toolResultContent(node.message) === undefined)
                    || isDeliveredAnswer(node.message));
            // Hash only: don't keep a second copy of user content or tools. The
            // public runtime projection is also what upstream actually replays.
            return createHash('sha256').update(JSON.stringify({
                turn, generation: session.surface.replaceGeneration,
                header: session.requestHeader(),
                system: alignSeqsToMessages(session, nodes.filter(seq => session.eventAt(seq)?.type === 'system/message')),
                selected: alignSeqsToMessages(session, selected),
                prices: measurement.nodes.slice(from, to + 1),
                tail, target: this.resolveSummarizationTarget(agent),
                adaptive: this.adaptive, config: this.config, spec,
            })).digest('hex');
        }
        catch {
            // An unfamiliar/non-serializable projection must not block recovery.
            return undefined;
        }
    }
    /** Model-free reduction only, for the paths where the provider owns compaction. */
    pruneOnly(session) {
        if (this.reduce(session, 'prune-only') > 0)
            this.stats.prunedOnly += 1;
        return null;
    }
    /** Resolve concrete budgets for the routed model, or null when capacity is unknown. */
    async specFor(agent, target, signal) {
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
        const contextWindow = info.context?.contextWindow;
        if (contextWindow === undefined) {
            // Upstream warns once per target and proceeds with full history. Matching
            // that is deliberate: a hard failure here would break every turn on a
            // route that merely forgot to declare its capacity.
            this.ctx.logger.warn(`adaptive compaction: no context capacity for ${target.provider}/${target.model}; `
                + 'set contextWindow on that adapter model or compaction cannot run');
            return null;
        }
        return resolveSpec(this.adaptive, contextWindow, info.defaultMaxTokens,
            agent.session.requestHeader()?.config.maxTokens ?? agent.options?.maxTokens ?? info.defaultMaxTokens);
    }
    passStateFor(session, turn, step) {
        const state = this.passes.get(session);
        return state?.turn === turn && state.step === step ? state : undefined;
    }
    recordPass(session, turn, step) {
        const state = this.passStateFor(session, turn, step);
        this.passes.set(session, { turn, step, passes: (state?.passes ?? 0) + 1 });
    }
    noteCompacted(session, measurement, turn) {
        this.lastCompaction.set(session, markOf(session, measurement, turn));
    }
    // ── which span ───────────────────────────────────────────────────────────
    /**
     * Remember the shadowed seqs, then delegate.
     *
     * The only reason to override this. `summarize()` receives messages but not
     * seqs, so provenance would otherwise be unavailable — and asking the model
     * for it produces guesses.
     */
    async compactRegion(start, end, agent, signal) {
        signal?.throwIfAborted();
        const nodes = agent.session.surface.nodes;
        const from = nodes.indexOf(start);
        const to = nodes.indexOf(end);
        if (from !== -1 && to !== -1 && from <= to) {
            this.pendingShadowed.set(agent.session, nodes.slice(from, to + 1));
        }
        try {
            // The parent captures its dependencies synchronously, before it
            // awaits the provider. Scope this signal only to that capture;
            // overlapping requests get independent guarded meter closures.
            const previous = this[REGION_SIGNAL];
            let operation;
            this[REGION_SIGNAL] = signal;
            try { operation = super.compactRegion(start, end, agent, signal); }
            finally { this[REGION_SIGNAL] = previous; }
            return await operation;
        }
        finally {
            // Cleared unconditionally: pressure and manual paths share one engine
            // instance, and a stale range would misattribute the next summary.
            this.pendingShadowed.delete(agent.session);
        }
    }
    regionDependencies() {
        const dependencies = super.regionDependencies();
        const signal = this[REGION_SIGNAL];
        if (signal === undefined) return dependencies;
        const meter = dependencies.meter;
        const guarded = Object.create(meter);
        // Automatic upstream transactions omit the manual path's pre-commit
        // abort check. Both frame pricing and final surface stability checks
        // occur after summarization and before any synchronous commit write.
        for (const key of ['estimateMessage', 'measure']) guarded[key] = (...args) => {
            signal.throwIfAborted();
            const value = meter[key](...args);
            signal.throwIfAborted();
            return value;
        };
        return {...dependencies, meter: guarded};
    }
    // ── what the checkpoint says ─────────────────────────────────────────────
    /**
     * Produce a structured checkpoint.
     *
     * Keeps upstream's replayed conversation in front of the instruction, so the
     * auxiliary call remains a genuine prefix of the last routed request and
     * reuses the provider's warm cache. Only the trailing instruction differs.
     *
     * @param input - the replayed prefix upstream assembled.
     * @param agent - supplies the routed target and session id.
     * @param signal - cancellation, forwarded to the adapter.
     * @returns the summary blocks plus the exact call envelope.
     */
    /**
     * ⚠️ This override is structurally narrower than the inherited signature: it
     * takes `AgentLike` rather than upstream's full `Agent`, and returns the
     * `llmStreamCall`-marked arm of upstream's result union. Both are sound at
     * runtime — the body uses only what `AgentLike` declares, and always sets the
     * marker — but neither is expressible through the inherited types under
     * `exactOptionalPropertyTypes`. `tsc` reports one variance error here by
     * design; see docs/02 for why widening the parent's types is not an option.
     */
    async summarize(input, agent, signal) {
        signal?.throwIfAborted();
        // Snapshot this admitted attempt before provider work yields. A rejected
        // concurrent request can still mutate the session-keyed staging maps.
        const minimum = this.pendingTrigger.get(agent.session) === 'pressure'
            ? this.adaptive.budget.minSavingsTokens : 0;
        const shadowed = this.pendingShadowed.get(agent.session)?.slice();
        const result = await this.summarizeUnchecked(input, agent, signal);
        // Pressure transactions in the pinned upstream runtime do not recheck
        // a cancelled caller before commit. Guard every native/sidecar branch.
        signal?.throwIfAborted();
        if (minimum > 0 && shadowed?.length) {
            const prices = this.ctx.tokenMeter.measure(agent.session).nodes;
            const selected = new Set(shadowed);
            const old = prices.filter(node => selected.has(node.seq));
            if (old.length === shadowed.length) {
                const before = old.reduce((total, node) => total + node.tokens, 0);
                const after = estimateMessage(createUserMessage({content:[
                    {type:'text',text:`${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}`},
                    ...result.summary, {type:'text',text:SUMMARY_CLOSE_TAG}
                ],source:{kind:'plugin',plugin:'dsh-compaction-adaptive'}}));
                if (before - after < minimum) {
                    this.stats.lowSavingsRejected += 1;
                    const error = new Error(`adaptive compaction: checkpoint saves only ${before-after} estimated tokens, below minimum ${minimum}`);
                    error.code = 'COMPACTION_LOW_SAVINGS'; throw error;
                }
            }
        }
        return result;
    }
    async summarizeUnchecked(input, agent, signal) {
        // SEC-06: secret-labelled content may never reach a cloud embedder, a
        // cloud summarizer, or the sidecar. Checked first, ahead of the mode
        // branch below: `mode: 'prose'` still delegates to `super.summarize()`,
        // which resolves and calls whatever upstream's own routing picks — it
        // does NOT by itself avoid a cloud call, so this gate has to guard both
        // branches, not just the structured one.
        //
        // Computed once and reused below (Codex review round 2): a session
        // whose secret content this exact call is allowed to see, because the
        // resolved target IS a local provider, still needs its resulting
        // checkpoint to carry durable secret provenance — otherwise a later
        // request that reroutes the session to a cloud provider would find no
        // marker to detect, since the checkpoint itself would be indistinguishable
        // from an ordinary one. `hasSecret` therefore also governs the anchors
        // ceiling on the normal (non-downgraded) structured path below, not just
        // the downgrade decision.
        const hasSecret = this.isSecretTainted(agent.session, input);
        const downgrade = this.secretDowngradeReason(agent, hasSecret);
        if (downgrade !== undefined) {
            this.stats.secretDowngrades += 1;
            this.ctx.logger.warn(`adaptive compaction: context.summary_downgraded_secret — ${downgrade}; `
                + 'skipping the summarization model call and rendering anchors-only');
            const result = this.anchorsOnlyResult(agent.session, this.buildAnchors(agent.session, input, 'secret'));
            return { ...result, summary: this.withSecretProvenance(result.summary, hasSecret) };
        }
        // Sidecar dispatch. Gated on `!hasSecret` directly, NOT on `downgrade`
        // being undefined: `secretDowngradeReason()` only asks whether a LOCAL
        // LLM provider is trusted for secret content (`security.localProviders`)
        // — that says nothing about the sidecar, a separate external
        // destination docs/05-sidecar-protocol.md §8 unconditionally forbids
        // secret content from reaching ("MUST NOT", no local-provider
        // carve-out). An operator trusting `security.localProviders: ['llamacpp']`
        // while also running `sidecar.mode: 'rest'` must not have that local
        // trust silently extended to the sidecar too. When `hasSecret` is true
        // and a local provider IS trusted, execution falls through to the
        // structured/prose local path below, completely unaffected by sidecar
        // config — exactly as before this feature existed.
        //
        // KNOWN SCOPE BOUNDARY (Codex review, PR #26 round 2): the sidecar
        // branch below returns before `reconcileOpenDeliverables()` (summary.ts)
        // ever runs — `sidecarSummarize()`'s own anchors check
        // (`findMissingAnchors`, further down this file) only proves a
        // deliverable's verbatim TEXT appears somewhere in the sidecar's
        // response, not that the response's own task-tracking (whatever shape a
        // given sidecar implementation uses) still marks it unanswered. Closing
        // that gap for real needs `task_state`-equivalent structure added to
        // `CompactResponseBody` (sidecar-serialize.ts) — a wire-protocol change
        // requiring every sidecar implementation to update, not a client-side
        // fix — and is out of scope here. Documented, not silently assumed
        // covered: see docs/05-sidecar-protocol.md §8.
        if (this.adaptive.sidecar.mode !== 'native' && !hasSecret) {
            return this.sidecarSummarize(input, agent, signal);
        }
        if (this.adaptive.summary.mode === 'prose') {
            return this.nativeFallback(input, agent, signal, hasSecret);
        }
        // hasSecret without a downgrade means a local provider is handling this
        // call safely, but the checkpoint still needs the 'secret' ceiling so a
        // later provider switch can't turn this pass into a leak (see the
        // comment on `hasSecret` above).
        const anchors = this.buildAnchors(agent.session, input, hasSecret ? 'secret' : undefined);
        const raw = await this.streamSummary(input, agent, signal);
        // Apply the same opt-in normalization to either response. A retry is
        // still one retry; only successfully parsed repairs count as repairs.
        const parseResponse = (text) => {
            const normalized = this.adaptive.summary.repairShape
                && this.adaptive.summary.mode !== 'flat'
                ? repairSummaryDocumentShape(text, this.adaptive.summary.schemaVersion) : {text, repairs: []};
            const parsed = this.adaptive.summary.mode === 'flat'
                ? parseFlatSummaryDocument(normalized.text, this.adaptive.summary.schemaVersion)
                : parseSummaryDocument(normalized.text, this.adaptive.summary.schemaVersion);
            if (normalized.repairs.length > 0) this.stats.shapeRepairs += 1;
            return parsed;
        };
        let doc;
        try {
            doc = parseResponse(raw.text);
        }
        catch (error) {
            this.stats.parseFailures += 1;
            switch (this.adaptive.summary.onParseError) {
                case 'fail':
                    throw error;
                case 'retry-once': {
                    const retry = await this.streamSummary(input, agent, signal, true);
                    doc = parseResponse(retry.text);
                    raw.blocks = retry.blocks;
                    // BOTH calls were billed, but `compaction/summary` carries a single
                    // usage. Overwriting with the retry's alone under-reported the cost of
                    // every retry — the exact accounting error telemetry exists to catch.
                    // Assign only when there is something to record: under
                    // exactOptionalPropertyTypes an explicit undefined is not the same as
                    // an absent key, and downstream distinguishes the two.
                    const combined = addUsage(raw.usage, retry.usage);
                    if (combined !== undefined)
                        raw.usage = combined;
                    break;
                }
                default: {
                    // Degrade rather than lose the compaction: the model's prose is still
                    // a summary, and the anchors — the machine-verified half — are intact.
                    this.stats.proseFallbacks += 1;
                    this.ctx.logger.warn(`adaptive compaction: summary did not parse (${String(error)}); `
                        + 'falling back to prose with anchors');
                    // Spilled here, not left to the caller below — this branch returns
                    // before ever reaching that call (Codex review, PR #26 round 12):
                    // without it, an overflowed anchor got only a bare-label stub with
                    // no recovery pointer, even when an artifact store was available
                    // and would have produced one, regardless of whether the
                    // malformed model prose happened to also omit it.
                    const parseErrorOverflowUri = this.spillOverflow(agent.session, anchors, hasSecret);
                    return this.result(raw, this.withSecretProvenance([{
                            type: 'text',
                            // Prose is raw model output, so it needs the scrub at least as much
                            // as the structured path does. hasSecret ceiling: same reasoning
                            // as the successful-parse rendering below.
                            text: this.redact(scrubUnresolvableUris(this.proseFallback(raw.text, anchors, parseErrorOverflowUri), this.artifactResolver(agent.session, hasSecret ? 'secret' : undefined))),
                        }], hasSecret));
                }
            }
        }
        if (this.adaptive.summary.verbatimFileArtifacts) {
            const redacted = this.redactMessages(input.messages);
            if (redacted.some(message => {
                if (message.role !== 'tool' && !(message.role === 'user' && message.source?.kind === 'tool'))
                    return false;
                const content = toolResultContent(message);
                return content === undefined || content.some(block => block?.type !== 'text'
                    || typeof block.text !== 'string');
            })) {
                // An unfamiliar tool protocol is not evidence that a valid quote
                // is absent. Reject this optional guarded checkpoint rather than
                // erase source information; the native transaction keeps history.
                const error = new Error('adaptive compaction: verbatim file evidence requires a supported text-only tool-result protocol');
                error.code = 'COMPACTION_UNSUPPORTED_TOOL_RESULT';
                throw error;
            }
            const toolTexts = redacted
                .map(toolResultContent)
                .filter(content => content !== undefined)
                .map(coalescedBlockText);
            doc = groundFileArtifacts(doc, toolTexts);
        }
        // Admission, not parsing: an empty structured model response must not
        // become raw-JSON prose or spend an extra retry. Local anchors cannot
        // establish that the model retained the rest of the selected history.
        // The intentional zero-model anchors-only path returns above unchanged.
        if (this.adaptive.summary.mode !== 'flat' && !hasSummaryDocumentContent(doc)) {
            const error = new Error('adaptive compaction: structured checkpoint contains no substantive content');
            error.code = 'COMPACTION_EMPTY_SUMMARY';
            throw error;
        }
        const overflowUri = this.spillOverflow(agent.session, anchors, hasSecret);
        // hasSecret ceiling here for the identical reason `anchors` above got it:
        // a local-provider pass is safe right now, but the rendered checkpoint
        // still needs to carry the secret marker for a later, possibly-cloud
        // pass to recognise (Codex review round 2).
        const text = renderSummary(doc, anchors, this.adaptive.summary.schemaVersion, overflowUri, this.artifactResolver(agent.session, hasSecret ? 'secret' : undefined), { compact: this.adaptive.summary.compactRendering });
        return this.result(raw, this.withSecretProvenance([{ type: 'text', text: this.redact(text) }], hasSecret));
    }
    /**
     * Delegate to upstream's own `super.summarize()` — prose mode's normal
     * path, and the sidecar's own failOpen recovery target
     * (docs/03-packages.md §4.7: "退回 `super.summarize()`", not this
     * engine's local structured path — falling open to structured mode would
     * impose a second, possibly-unconfigured local-provider requirement on a
     * sidecar-only deployment; falling open to `super.summarize()` matches
     * upstream's own default and needs no new configuration to succeed when
     * one genuinely exists).
     *
     * Never builds its own request — `streamSummary()`'s own
     * `redactMessages()` call is skipped entirely, and without this, so is
     * every credential check: `input` is upstream's own replayed prefix,
     * sent to whatever provider upstream's `summarize()` calls internally,
     * exactly as the structured path's replayed prefix would be without the
     * same fix.
     */
    async nativeFallback(input, agent, signal, hasSecret) {
        const redactedInput = {
            ...input,
            messages: this.redactMessages(input.messages),
            ...(input.system === undefined
                ? {} : { system: this.redact(input.system, 'a replayed system prompt') }),
            ...(input.tools === undefined
                ? {} : { tools: this.redactToolDefinitions(input.tools) }),
        };
        const result = await super.summarize(redactedInput, agent, signal);
        // The structured path's own `this.redact(text)` call covers exactly
        // this — SEC-02's scenario, a model narrating why it refused an
        // injected instruction while reproducing the credential verbatim — for
        // the RENDERED checkpoint text. This method returns upstream's result
        // directly, with nothing between the model's own words and the durable
        // `compaction/summary` event those words become. Once committed, a
        // token copied into a checkpoint stays in the session's memory for the
        // rest of its life.
        //
        // rawOutput needs the same pass, not just summary: upstream's own
        // commitCompactionBody() writes BOTH fields into that one durable event
        // when llmStreamCall is set (replay provenance for the warm cache) —
        // summary alone being clean does not make the event clean. this.result()
        // (the structured path's own equivalent, above) needs the identical
        // treatment for the identical reason, which is why this lives as a
        // shared method rather than a closure local to one caller.
        //
        // hasSecret is still the only PROVENANCE signal here (Codex review round
        // 3) — building/rendering anchors below (round 8, extended round 10 to
        // include a genuine Anchors block) adds no second, richer provenance
        // mechanism alongside the marker.
        //
        // neutralizeAnchorImpersonation() (Codex review, PR #26 round 5): this
        // is upstream's OWN raw model prose, becoming the checkpoint with NO
        // wrapping from this package's own renderSummary()/renderAnchors() at
        // all — round 4's fix only reached the sidecar path, leaving this one
        // (the DEFAULT path for any deployment not using structured
        // summarization, and — via sidecar.failOpen — the recovery target for
        // EVERY sidecar failure too) open to the identical impersonation: a
        // literal "## Anchors" heading anywhere in the model's own prose gets
        // the same trust a genuine local anchor block gets on the next
        // compaction, upstream applying an identical checkpoint source marker
        // regardless of which path produced the text.
        // neutralizeAcrossBlocks() (Codex review, PR #26 round 23, the
        // identical gap round 21's Finding 6 already fixed for the sidecar
        // path, missed here): the old per-block `.map()` could not catch a
        // heading split across two adjacent `text` blocks, the same way
        // `coalesceRedactWire()`'s own credential-only merging couldn't —
        // `coalescedBlockText()` (round 20) re-reads this exact checkpoint on
        // the NEXT round joining directly-adjacent blocks with no separator,
        // reconstructing an intact, never-neutralized heading from the two
        // untouched halves, promoting whatever model-authored lines follow it
        // to machine-verified status. `result.summary` here can never actually
        // contain a `reasoning` block to begin with — upstream's own
        // `summaryText()` (confirmed by reading its compiled source,
        // `@deepseek-ai/dsh-compaction-basic`) unconditionally filters
        // `assembler.blocks()` down to `type === 'text'` before this method
        // ever sees anything, so `neutralizeAcrossBlocks()`'s own `reasoning`
        // handling is defensive/shared-with-the-sidecar-path only at this
        // call site, not closing a live gap for that specific shape the way
        // it genuinely does for the sidecar's own wire-sourced blocks.
        const neutralized = this.neutralizeAcrossBlocks(this.withSecretProvenance(this.redactRawBlocks(result.summary), hasSecret));
        // Deliverables backstop for this path too (Codex review, PR #26 round
        // 8): unlike the sidecar path's documented scope boundary
        // (docs/05-sidecar-protocol.md §8 — a protocol gap needing every sidecar
        // implementation to update), this path runs entirely locally and has
        // every source message available, the same as the structured path does.
        // Returning the model's raw prose completely unchecked means a model
        // that simply omits Q1 from its own summary has that question pruned
        // away with nothing to catch it — reproducing the exact incident this
        // whole mechanism exists to close, on the one path (the DEFAULT for any
        // deployment not opted into structured summarization, and every sidecar
        // failOpen target) that had no backstop of any kind until now.
        // Checked against the fully-processed text, not the model's raw output —
        // what matters is what the FINAL checkpoint says, and redaction/
        // neutralization change none of a real label's own characters. Built
        // from the untouched `input`, not `redactedInput` — anchors trace back
        // to shadowed session content via seq, same as every other caller of
        // buildAnchors().
        const anchors = this.buildAnchors(agent.session, input, hasSecret ? 'secret' : undefined);
        const finalText = coalescedBlockText(neutralized);
        // A genuine, carry-forward-safe `## Anchors` block, filtered to just
        // deliverables (Codex review, PR #26 round 10 — three findings at once).
        // Round 9's own backstop only preserved a deliverable's full text
        // CONDITIONALLY, embedded inside a note appended when the model's prose
        // failed the leading-label check — three real gaps followed from that:
        // (1) a bare status sentence like "Q1 remains unresolved" satisfies the
        // leading-label check (the label genuinely opens its own sentence)
        // while preserving nothing about what Q1 actually asked; (2) even when
        // the note DID fire, "## Unresolved Deliverables" is not a heading
        // `anchorsFromCheckpoint()` (anchors.ts) recognizes, so on a LATER
        // compaction the checkpoint has no `## Anchors` block for it to find —
        // a second prose summary omitting the same deliverable loses it for
        // good, with no further backstop; (3) unresolvedDeliverables()
        // deliberately returns only ONE entry per colliding label (matching the
        // structured path's own "one note per label" choice) — safe there only
        // because the structured path's Anchors block ALSO separately preserves
        // every colliding anchor's full text regardless of label collisions;
        // prose had no such block, so the note being the ONLY record meant the
        // second colliding question was dropped immediately, not just on a
        // later round. Reusing `renderAnchors()` unmodified against a
        // deliverables-only `AnchorSet` reuses the ENTIRE existing,
        // carry-forward-tested mechanism instead of inventing a parallel one:
        // every deliverable extracted THIS round — kept or overflowed, tracked
        // or not, colliding pairs included (the `(seq, text)` dedup key already
        // keeps distinct same-label collisions separate, round 4/5) — gets a
        // genuine `- deliverable: <full text>` entry unconditionally, or a
        // `deliverable_ref` stub (carrying an artifact pointer, if
        // `spillOverflow()` below succeeds) when the local anchor budget
        // evicted it. `neutralizeAnchorImpersonation()` above already ran on
        // `neutralized` (the model's OWN prose) BEFORE this block exists — a
        // model that tried to forge its own "## Anchors" heading already had it
        // broken; this module's own genuine heading, appended separately below,
        // is never itself run through that same neutralization pass (it would
        // be wrong to mangle real, machine-generated output the exact way a
        // forged one gets mangled).
        const deliverableAnchors = {
            all: anchors.all.filter(anchor => anchor.kind === 'deliverables'),
            overflow: anchors.overflow.filter(anchor => anchor.kind === 'deliverables'),
            rejected: anchors.rejected,
            ...(anchors.lastAssistantSeq === undefined ? {} : {lastAssistantSeq: anchors.lastAssistantSeq}),
        };
        // Spilled only when the rendered block below actually has something to
        // point the URI at (Codex review, PR #26 round 11): `spillOverflow()`
        // gates on `isTruncated(anchors)` — the FULL, unfiltered set — so an
        // errors- or files-only overflow (no deliverables involved at all)
        // still wrote a real artifact even though `renderAnchors()` below is
        // called against `deliverableAnchors`, whose OWN overflow is empty in
        // that case; its own `isTruncated()` check never renders the
        // bookkeeping line the returned URI would appear in, so the artifact
        // this call just wrote becomes permanently unreferenced from anywhere
        // in the checkpoint — a real write with no pointer, repeated on every
        // such prose compaction. Gating on `isTruncated(deliverableAnchors)`
        // first means the spill is only attempted when there is a deliverable
        // stub that will actually carry the pointer.
        // Spills `deliverableAnchors` itself, not the full `anchors` (Codex
        // review, PR #26 round 21, a real gap the round-11 gate above did not
        // close): prose mode has no mechanism to ever CITE a pointer for a
        // non-deliverable kind's overflow — `renderAnchors()` right below is
        // already called against `deliverableAnchors`, so its own `- overflow:
        // N more anchors` bookkeeping line only ever reflects the deliverables
        // count — spilling the full set bundled every evicted error/file/test/
        // etc. into the SAME artifact write for no referenceable benefit, and
        // made that write bigger than it needed to be for no reason. That
        // matters concretely since round 19's own fix: if the COMBINED
        // (all-kinds) content exceeds the store's `maxArtifactBytes`,
        // `spillOverflow()` correctly refuses to cite a truncated artifact and
        // returns `undefined` — discarding the pointer even when the
        // deliverables-only portion, spilled on its own, would have fit
        // intact. Scoping the spill to what's actually referenced avoids
        // manufacturing that truncation in the first place.
        const overflowUri = isTruncated(deliverableAnchors)
            ? this.spillOverflow(agent.session, deliverableAnchors, hasSecret)
            : undefined;
        const anchorBlock = renderAnchors(deliverableAnchors, overflowUri);
        // The short nudge note is unchanged in SHAPE from round 8 — round 9's
        // full-text-embedding fix is reversed (anchors.ts's own doc on
        // `unmentionedDeliverableNote()`): with the Anchors block above now
        // preserving full text unconditionally, this only decides whether to
        // add an immediate prompt for the model working THIS round, exactly
        // like `reconcileOpenDeliverables()`'s own Pending Jobs note does for
        // the structured path.
        const missing = unmentionedDeliverableNotes(anchors, finalText);
        const appendedParts = [];
        if (anchorBlock.length > 0) {
            appendedParts.push(`${ANCHORS_BLOCK_HEADING}\n${anchorBlock}`);
        }
        if (missing.length > 0) {
            appendedParts.push(`## Pending Jobs (machine-checked)\n${missing.map(note => `- ${note}`).join('\n')}`);
        }
        // Both sections are built from buildAnchors()'s raw extraction, never
        // through redactRawBlocks() or scrubUnresolvableUris() the way
        // `neutralized` already was (Codex review, PR #26 round 9, extended
        // round 10 to cover the new Anchors block too): a credential in the
        // original human turn, or an unresolvable/cross-tenant `artifact://`
        // URI a carried-forward stub embeds, would otherwise reach this durable
        // checkpoint completely unredacted and unscrubbed.
        const appendedText = appendedParts.length === 0 ? undefined : this.redact(scrubUnresolvableUris(appendedParts.join('\n\n'), this.artifactResolver(agent.session, hasSecret ? 'secret' : undefined)));
        const summary = appendedText === undefined ? neutralized : [
            ...neutralized,
            { type: 'text', text: `\n\n${appendedText}` },
        ];
        return {
            ...result,
            summary,
            ...(result.rawOutput === undefined ? {} : { rawOutput: this.redactRawBlocks(result.rawOutput) }),
        };
    }
    /**
     * The REST sidecar path (docs/05-sidecar-protocol.md §2/§4): delegate
     * summarization to an external service instead of a local
     * `ctx.llm.stream()` call. Reached only when `!hasSecret` — see the
     * caller's own comment in `summarize()`.
     *
     * `this.sidecarClient!`: the non-null assertion is safe by construction
     * — this method is reachable only when `sidecar.mode !== 'native'`, and
     * the constructor throws for `'grpc'`, so the only mode that reaches
     * here is `'rest'`, for which the constructor always builds a client.
     */
    async sidecarSummarize(input, agent, signal) {
        const session = agent.session;
        // Captured HERE, synchronously, before this method's own first await
        // (specFor() below) — not read inline where `body` is built, further
        // down (Codex review, PR #18 round 3, fresh evidence after round 1's
        // own fix narrowed but did not close this): compactIfNeeded()'s while
        // loop already sets pendingTrigger fresh immediately before calling
        // compactRegion(), with no await between that set() and this method
        // being entered — but THIS method has its own await (specFor(),
        // resolving model capacity) before the trigger was previously read. A
        // concurrent compactNow() can still land in that window, set
        // pendingTrigger to 'manual' for the same session before its own
        // admission is rejected as busy, and have this in-flight automatic
        // compaction read that stale 'manual' value instead of its own.
        // Capturing before the await closes that specific gap; whatever
        // upstream's own compactRegion() does before reaching this method at
        // all remains outside this package's control, as documented where
        // compactNow() sets its own value.
        const trigger = this.pendingTrigger.get(session) ?? 'manual';
        const ifMatch = String(session.surface.replaceGeneration);
        const nodes = this.shadowedNodesFor(session, input);
        const anchors = this.buildAnchors(session, input, undefined);
        // Anchors are extracted verbatim from raw error lines, test output,
        // command lines, and user_pins constraints — any of which can carry a
        // credential (Codex review: `MUST: use sk-...` becomes a verbatim
        // `user_pins` anchor). `hasSecret` (the caller's own gate) only detects
        // LABELLED artifact-URI secret provenance (SEC-06), a completely
        // separate mechanism from generic credential-PATTERN redaction — it
        // does nothing to stop a plain credential in anchor text. The native
        // structured path already covers this for free: it redacts the WHOLE
        // rendered checkpoint text, anchors included, in one pass
        // (`this.redact(text)` in the caller of `renderSummary()`); this path
        // has no equivalent single rendering step, so anchors need their own
        // explicit pass. Computed once, reused for BOTH the request body below
        // AND the response-verbatim check further down — checking the response
        // against the ORIGINAL, unredacted anchor text would compare against
        // something the sidecar was never even shown.
        // `anchors.all` alone omits overflowed deliverables (Codex review, PR
        // #26 round 10): the local budget deliberately evicts them from `.all`
        // to bound the INLINE checkpoint's own Anchors block — a wire request's
        // `anchors[]` field has no equivalent "inline space" to protect, so
        // applying that local constraint here just means the sidecar never
        // sees the question at all, has no chance to answer it, and
        // findMissingAnchors() below never checks for it either — the original
        // shadowed turn can then be pruned with the deliverable answered
        // nowhere. Scoped to `deliverables` specifically, not every overflowed
        // anchor of every kind: only deliverables carry the "never silently
        // drop" guarantee (round 6/8/9's own reasoning for removing every
        // count/length cap on this one kind, applied here to the sidecar
        // wire protocol too) — an overflowed error or file anchor is still
        // legitimately droppable.
        const deliverableOverflow = anchors.overflow.filter(anchor => anchor.kind === 'deliverables');
        // scrubUnresolvableUris() first, matching nativeFallback()'s own
        // ordering below — a carried deliverable_ref stub embeds its prior
        // round's own `recoveredPointer` directly IN `anchor.text` (round 14's
        // rendering shape, "<label> (full text: <uri>)"), and that pointer's
        // artifact can have expired or never existed for THIS session's own
        // store (Codex review, PR #26 round 21, a real gap): this path applied
        // only credential redaction, never resolvability scrubbing, so an
        // unreadable artifact fingerprint was sent externally to the sidecar
        // unmodified — and, since the sidecar's own response text becomes
        // `redactedAnchors`' basis for the next round's carry-forward chain (a
        // stub that "fits budget" re-renders under its OWN `recoveredPointer`,
        // not a fresh one — see `renderAnchors()`'s own doc, round 21), an
        // already-dangling pointer could keep circulating instead of being
        // caught here, the same way the local paths already catch it.
        // `recoveredPointer` is scrubbed alongside `text`, not left as-is
        // (Codex review, PR #26 round 22, a real gap in round 21's own fix
        // above): it is a SEPARATE field holding the same URI `text` embeds,
        // and `renderAnchors()` reads it DIRECTLY when re-rendering this
        // anchor as a `deliverable_ref` stub — since round 21's own Finding 4,
        // it now PREFERS `recoveredPointer` over any fresh spill URI. Scrubbing
        // only `text` left the field itself untouched: the exact unresolvable
        // fingerprint just removed from the request's own anchor text would
        // still be re-emitted, verbatim, in the machine-authenticated Anchors
        // block this method appends to the sidecar's response before it
        // becomes the durable checkpoint — the same information leaving by a
        // different door. Cleared only when the pointer is ACTUALLY
        // unresolvable (checked directly, not inferred from whether `text`
        // changed — the marker text `scrubUnresolvableUris()` substitutes is
        // not itself a URI `resolver` would recognise), matching the surgical,
        // substring-level precision `scrubUnresolvableUris()` itself already
        // applies to `text` rather than clearing every carried pointer
        // unconditionally.
        const redactAnchor = (anchor) => {
            const resolver = this.artifactResolver(session);
            const { recoveredPointer, ...rest } = anchor;
            // `resolver === undefined` (no ArtifactStore composed at all) means
            // "not checked," not "checked and failed" — Codex review, PR #26
            // round 24, a real bug in this exact fix: `resolver?.(...)` short-
            // circuits to `undefined` whenever `resolver` itself is absent,
            // which previously read identically to "the pointer failed to
            // resolve," clearing recoveredPointer on every anchor whenever no
            // store was composed, regardless of whether the pointer was ever
            // actually invalid. `scrubUnresolvableUris()` right below already
            // treats an absent resolver as "leave `text` alone" for the
            // identical reason; this field needs the same absent-resolver
            // exemption to stay consistent with it.
            // `resolver === undefined` (no ArtifactStore composed at all) means
            // "not checked," not "checked and failed" — Codex review, PR #26
            // round 24, a real bug in this exact fix: `resolver?.(...)` short-
            // circuits to `undefined` whenever `resolver` itself is absent,
            // which previously read identically to "the pointer failed to
            // resolve," clearing recoveredPointer on every anchor whenever no
            // store was composed, regardless of whether the pointer was ever
            // actually invalid. `scrubUnresolvableUris()` right below already
            // treats an absent resolver as "leave `text` alone" for the
            // identical reason; this field needs the same absent-resolver
            // exemption to stay consistent with it.
            // `resolver === undefined` (no ArtifactStore composed at all) means
            // "not checked," not "checked and failed" — Codex review, PR #26
            // round 24, a real bug in this exact fix: `resolver?.(...)` short-
            // circuits to `undefined` whenever `resolver` itself is absent,
            // which previously read identically to "the pointer failed to
            // resolve," clearing recoveredPointer on every anchor whenever no
            // store was composed, regardless of whether the pointer was ever
            // actually invalid. `scrubUnresolvableUris()` right below already
            // treats an absent resolver as "leave `text` alone" for the
            // identical reason; this field needs the same absent-resolver
            // exemption to stay consistent with it.
            const keepPointer = recoveredPointer !== undefined
                && (resolver === undefined || resolver(recoveredPointer) !== undefined);
            return {
                ...rest,
                ...(keepPointer ? { recoveredPointer } : {}),
                text: this.redact(scrubUnresolvableUris(anchor.text, resolver), 'a sidecar request anchor'),
            };
        };
        const redactedAnchors = [...anchors.all, ...deliverableOverflow].map(redactAnchor);
        // Redacted right before it leaves the process (docs/05 §8: "送出前對
        // surface 做 secret redaction"), on the DOMAIN message via the same
        // redactMessages() the native paths already use, BEFORE mapping to
        // wire form — not per wire block after mapping (Codex review): a
        // credential split across two adjacent text/reasoning blocks (e.g.
        // `sk-` + 12 chars in one block, the rest in the next) is invisible
        // to a per-block redaction pass, even though the sidecar receives
        // both fragments and can reconstruct
        // it — exactly the "adjacent-block fragmentation" shape
        // redactMessages()'s own coalescing already exists to close for the
        // native paths (see its own doc comment); this wire path was
        // reintroducing that exact, already-fixed-once vulnerability class.
        // redactMessages() is called per-node (a one-message array), not once
        // over `input.messages`, because `node.message` is not reliably the
        // SAME object reference `input.messages` holds — alignSeqsToMessages()
        // re-derives messages from the session's own events independently —
        // so there is no reliable way to align a separately-redacted
        // input.messages copy back onto `nodes` by identity.
        const surface = nodes.map((node) => {
            const [redactedMessage] = this.redactMessages([node.message]);
            const wireNode = toSurfaceNode({ seq: node.seq, message: redactedMessage ?? node.message });
            return { ...wireNode, content: this.coalesceRedactWire(wireNode.content) };
        });
        // Both optional on the wire; the CompactRequest schema has no `system`/
        // `tools` fields at all (docs/05 §4) — only `surface` — so there is
        // nothing to redact or send for those two.
        const target = this.resolveSummarizationTarget(agent);
        // specFor() itself requires a real AbortSignal (it forwards to
        // ctx.llm.resolveModelInfo(), which does too) — but THIS method's own
        // signal is optional, and summarize()'s public signature allows a
        // caller to omit it entirely. Treating "no signal" as "capacity
        // unresolvable" (Codex review, PR #18 round 2) meant REST mode silently
        // fell back to native — or failed outright with failOpen:false — for
        // every signal-less call, even when the target's own metadata was
        // complete. A fresh, never-aborted signal only stands in for genuine
        // cancellation the caller never offered; it changes nothing when a
        // real signal IS present, since `??` never evaluates its right side then.
        const spec = target === undefined
            ? null
            : await this.specFor(agent, target, signal ?? new AbortController().signal);
        // context_limit/output_reserve are REQUIRED wire fields (docs/05 §4's
        // own CompactRequest.required list), not optional ones — confirmed
        // against the actual schema (Codex review; an earlier version treated
        // them as omittable like provider/model, which are genuinely
        // optional). Manual and context-overflow compaction can both reach
        // this method with unresolvable model capacity (compactNow() never
        // gates on specFor() the way the pressure path's own compactIfNeeded()
        // does), so there is no way to always have a real number here — and
        // sending a GUESSED one would misinform the sidecar about the model's
        // real context window, worse than not sending the field at all. A
        // request this code cannot build to spec would fail schema validation
        // against any real, conformant sidecar anyway, so failing open locally
        // — without ever spending a network round trip on a request destined
        // to be rejected — is strictly better than attempting it.
        if (target === undefined || spec === null) {
            return this.sidecarFailOpen(input, agent, signal, 'cannot resolve a summarization target/model capacity, which the sidecar wire protocol '
                + 'requires (context_limit/output_reserve are required CompactRequest fields)', 'context.sidecar_call_failed', 
            // No request was ever built to be malformed, strictly speaking —
            // 'malformed' is still the closest of the four available reasons
            // (not a timeout, not a network error, not a real HTTP status).
            'malformed');
        }
        const body = {
            api_version: '1',
            tenant_id: this.adaptive.sidecar.tenantId,
            session_id: session.id,
            generation: ifMatch,
            trigger,
            anchors: redactedAnchors.map(anchor => anchor.text),
            surface,
            policy: this.adaptive,
            provider: target.provider,
            model: target.model,
            context_limit: spec.contextWindow,
            output_reserve: spec.outputReserve,
        };
        this.stats.sidecarCalls += 1;
        let response;
        try {
            response = await this.sidecarClient.compact({ idempotencyKey: randomUUID(), ifMatch, body }, signal);
        }
        catch (error) {
            // SidecarClient's own fetch()/response-read catches already re-check
            // the caller's signal and rethrow the caller's OWN abort reason
            // as-is when that is what actually happened (rounds 2-3's own
            // fixes) — but this catch, one level up, still routed EVERY error
            // through sidecarFailOpen() unconditionally: failOpen:true invoked
            // the local model after the caller had already cancelled (wasted,
            // unwanted work), and failOpen:false replaced the caller's own
            // cancellation reason with a fresh SidecarRejectedError (Codex
            // review, PR #18 round 4, fresh evidence after the client-level
            // fixes). Re-checked FIRST, before even the CAS/409 classification
            // below — once the caller has genuinely cancelled, no further
            // classification of what the sidecar did or didn't do matters.
            signal?.throwIfAborted();
            if (error instanceof SidecarChangedError) {
                this.stats.sidecarChanged += 1;
                this.ctx.logger.warn(`adaptive compaction: context.sidecar_response_changed — ${String(error)}`);
                throw error;
            }
            // Timeout, network error, non-409 HTTP failure, or a malformed 200 —
            // every SidecarRejectedError reason, and anything else unexpected.
            // SidecarClient already classified this correctly one layer down;
            // reuse its own reason rather than discarding it (Codex review).
            return this.sidecarFailOpen(input, agent, signal, `sidecar call failed: ${String(error)}`, 'context.sidecar_call_failed', error instanceof SidecarRejectedError ? error.reason : 'network', error instanceof SidecarRejectedError ? error.status : undefined);
        }
        // CAS check #1, right after the call (docs/05 §2: "檢查
        // response.sourceGeneration === snapshot.generation，不符 → 視為
        // changed" — a mismatched-but-200 response gets the identical
        // treatment a 409 does).
        if (response.source_generation !== ifMatch) {
            this.stats.sidecarChanged += 1;
            this.ctx.logger.warn(`adaptive compaction: context.sidecar_response_changed — source_generation `
                + `(${response.source_generation}) did not match the request's If-Match (${ifMatch})`);
            throw new SidecarChangedError('sidecar: surface generation changed — response source_generation '
                + 'did not match the request');
        }
        // summary_sha256 check — SEC-07. Constant-time comparison: a tamper
        // check is exactly the kind of comparison a timing side channel can
        // undermine.
        //
        // Buffer.from(_, 'hex') silently stops decoding at the first invalid
        // character and returns whatever it decoded up to that point, rather
        // than throwing — so '<64 valid hex><garbage>' would decode to the
        // exact same 32 bytes as a correctly-formatted digest alone, and both
        // the length check and timingSafeEqual below would accept it (Codex
        // review, PR #18 round 3 — the same shape as round 2's webhook
        // signature fix, applied here to the wire response's own digest
        // field). Reject anything that is not EXACTLY 64 hex characters
        // before ever decoding it.
        const validHexDigest = /^[0-9a-f]{64}$/i.test(response.summary_sha256);
        const expected = Buffer.from(summarySha256(response.summary), 'hex');
        const actual = Buffer.from(response.summary_sha256, 'hex');
        const shaMatches = validHexDigest
            && actual.length === expected.length && timingSafeEqual(actual, expected);
        if (!shaMatches) {
            return this.sidecarFailOpen(input, agent, signal, 'summary_sha256 did not match the canonical hash of the returned summary', 'security.sidecar_response_rejected', 'malformed');
        }
        // CAS check #2, immediately before returning — a second, independent
        // read, not reused from check #1 (docs/05 §2: "harness 在收到回應後與
        // 上游 commit 前各比一次"). There is no hook later than this method's
        // own return: `assertStable()`/`commitCompactionBody()` run entirely
        // inside upstream's `compactSurfaceRegion()` after `summarize()`
        // returns.
        if (String(session.surface.replaceGeneration) !== ifMatch) {
            this.stats.sidecarChanged += 1;
            this.ctx.logger.warn('adaptive compaction: context.sidecar_response_changed — surface generation moved '
                + 'while awaiting the sidecar response');
            throw new SidecarChangedError('sidecar: surface generation changed while the sidecar was responding');
        }
        // provider/model are a fixed, honest sentinel, not the declined/
        // resolved target — echoing the request's own provider/model would
        // misleadingly imply the sidecar actually routed there, when it may
        // have used something else entirely (matches SEC-06's own
        // `{provider:'none', model:'anchors-only'}` precedent). llmStreamCall
        // is never set (docs/05 §4 and docs/03 §4.7 both forbid it — a sidecar
        // call consumed no local ctx.llm.stream() call) and neither is
        // rawOutput (would misleadingly imply warm-cache replay provenance
        // that does not exist for this path).
        // coalesceRedactWire() runs FIRST, on the wire array — a credential
        // split across two adjacent wire blocks is still one contiguous
        // string there; fromWireContentBlocks() would already have lost that
        // adjacency information by turning each block into its own TextBlock.
        // redactRawBlocks() still runs after, as a second, already-established
        // backstop (cheap and idempotent against already-clean text).
        // neutralizeAnchorImpersonation() runs last, over the fully-assembled
        // text, UNCONDITIONALLY — no exemption for any substring, including
        // redactedAnchors' own text (Codex review, PR #26 round 13, reversing
        // round 12's own exemptSubstrings mechanism): a sidecar response
        // containing (by coincidence or by design) a literal "## Anchors"
        // heading would otherwise get the SAME trust a genuine local anchor
        // block gets from anchorsFromCheckpoint() on the next compaction — the
        // KNOWN SCOPE BOUNDARY comment above this method already establishes
        // the sidecar's own task-tracking is unverified; this closes the
        // sharper case where its OUTPUT actively impersonates this package's
        // own machine-verified rendering (Codex review, PR #26 round 4). Round
        // 12 exempted each anchor's own text from this rewrite so a legitimate
        // multiline deliverable containing a "## Anchors"-shaped line of its
        // own would not get mangled — but that same exemption let a malicious
        // sidecar wrap a real anchor's own heading-shaped line and immediately
        // append attacker-authored `- deliverable: ...` lines right after it:
        // anchorsFromCheckpoint() trusts everything shaped like an anchor line
        // after ANY surviving heading, with no way to tell why that heading
        // survived, so protecting the heading protected whatever followed it
        // too. See the anchors-contract check below (moved here, after this
        // point) for how the "don't silently corrupt an already-verified
        // anchor" half of round 12's own motivation is preserved without the
        // exemption.
        const summary = this.neutralizeAcrossBlocks(this.redactRawBlocks(fromWireContentBlocks(this.coalesceRedactWire(response.summary), this.artifactResolver(session))));
        // Anchors contract — INT-18 (docs/05 §4: "anchors[] 中的每一條都必須逐字
        // 出現在回傳的 summary 中；harness 會驗（若缺，視為 summary 失敗）"). Checked
        // against redactedAnchors, matching what the request actually sent —
        // the sidecar was never shown the unredacted originals, so comparing
        // against those would demand verbatim reproduction of text it never saw.
        // Checked against the FINAL `summary` — after redaction AND
        // neutralizeAnchorImpersonation() have both already run (Codex review,
        // PR #26 round 13) — not the raw wire response: neutralization above is
        // now fully unconditional, so if it happens to rewrite a heading-shaped
        // line that was legitimately part of a verified anchor's own text, this
        // check catches that HERE, as a genuine "not reproduced verbatim"
        // failure, and falls open exactly like any other malformed response.
        // That is the same "would rather lose an anchor than risk trusting
        // something unverified" bias I12 itself is built on, applied to the one
        // sidecar-specific step (neutralization) capable of altering
        // already-verified text after the fact — not a bespoke carve-out.
        //
        // This is NOT the same guarantee reconcileOpenDeliverables() (summary.ts)
        // gives the local path (see the KNOWN SCOPE BOUNDARY comment above this
        // method): verbatim presence in the final summary proves the sidecar
        // didn't drop the QUESTION's text, not that its own response still
        // marks that deliverable unanswered rather than, say, only mentioning it
        // while narrating a different, unrelated item as done.
        const missing = findMissingAnchors(redactedAnchors, coalescedBlockText(summary));
        if (missing.length > 0) {
            return this.sidecarFailOpen(input, agent, signal, `${missing.length} anchor(s) were not reproduced verbatim in the sidecar's response`, 'context.sidecar_anchors_missing', 'malformed');
        }
        // SidecarClient's own hasContent check (validateCompactResponse())
        // only authenticates the WIRE shape — a valid-looking, non-empty
        // artifact_ref/image_ref sha256 counts as "content" there regardless
        // of whether it is a well-formed digest or resolves to anything real
        // (Codex review, PR #18 round 5, fresh evidence after the blank-text
        // fix): a malformed digest string synthesizes into inert, unmatched
        // text (ARTIFACT_URI_IN_TEXT requires exactly 64 hex characters), and
        // a well-formed-but-nonexistent digest gets scrubbed to the fixed
        // UNRESOLVABLE marker by artifactResolver() above — neither is a
        // substantive summary of what was compacted. This is the LATER,
        // authoritative check: only HERE, after fromWireContentBlocks() has
        // actually run scrubUnresolvableUris() with a real resolver, is it
        // possible to tell "a genuine citation" from "a reference that didn't
        // pan out" — sidecar-client.ts has no artifact-store access to make
        // that call itself.
        const hasSubstance = summary.some(block => (block.type === 'text' && block.text.trim().length > 0 && block.text !== UNRESOLVABLE));
        if (!hasSubstance) {
            return this.sidecarFailOpen(input, agent, signal, 'response summary contained no substantive content — only blank text and/or references '
                + 'that could not be resolved to anything real', 'context.sidecar_call_failed', 'malformed');
        }
        // A genuine, carry-forward-safe `## Anchors` block, filtered to just
        // deliverables — the sidecar path's own counterpart to
        // nativeFallback()'s unconditional block (round 10), closing a gap the
        // verbatim check above never could (Codex review, PR #26 round 15):
        // findMissingAnchors() only proves THIS round's response reproduced
        // every anchor somewhere in its prose, but neither that one-time proof
        // nor the sidecar's own prose text leaves anything
        // anchorsFromCheckpoint() (anchors.ts) can recognize on a LATER
        // compaction — a sidecar response never carries a real "## Anchors"
        // heading (neutralizeAnchorImpersonation() above deliberately breaks
        // any that would look like one, round 4/13's own impersonation
        // defense), so once the ORIGINAL human turn is itself eventually
        // pruned, a verified-but-uncaptured deliverable has no durable trace
        // left anywhere — this is distinct from the KNOWN SCOPE BOUNDARY
        // documented above this method (whether THIS round's own task
        // tracking is trustworthy) and from round 10's same-round overflow
        // fix (whether an overflowed deliverable even reached the sidecar's
        // request) — both are about a SINGLE round; this is about surviving
        // into the NEXT one at all. Built from `anchors` — this method's own
        // extraction, never the sidecar's response — and redacted the same
        // way the request body was; never run through
        // neutralizeAnchorImpersonation() (that exists only to scrub
        // SIDECAR-supplied text, the same asymmetry nativeFallback()'s own
        // doc on this establishes for its own Anchors block).
        const deliverableAnchorSet = {
            all: anchors.all.filter(anchor => anchor.kind === 'deliverables').map(redactAnchor),
            overflow: deliverableOverflow.map(redactAnchor),
            rejected: anchors.rejected,
            ...(anchors.lastAssistantSeq === undefined ? {} : {lastAssistantSeq: anchors.lastAssistantSeq}),
        };
        // Gated on `isTruncated(anchors)` — the FULL, unfiltered set, not
        // `deliverableAnchorSet` — for the identical reason nativeFallback()'s
        // own spill gate is (its own doc, above): an errors- or files-only
        // overflow with no deliverables involved would otherwise still spend a
        // real artifact write with no pointer anywhere in the checkpoint to
        // reference it.
        //
        // Spills `deliverableAnchorSet` itself, not the full `anchors` (Codex
        // review, PR #26 round 22 — the same gap round 21's Finding 7 already
        // fixed for `nativeFallback()`'s own equivalent Anchors block, missed
        // here): `renderAnchors()` right below is already called against
        // `deliverableAnchorSet`, so its own `- overflow: N more anchors`
        // bookkeeping line only ever reflects the deliverables count — an
        // unrelated, larger error/file/test overflow bundled into the SAME
        // spill could push the combined content over the store's
        // `maxArtifactBytes` even when the deliverable-only portion, spilled
        // alone, would have fit intact, and round 19's own truncation-safety
        // fix then correctly discards a pointer that never needed to be at
        // risk.
        const anchorOverflowUri = isTruncated(deliverableAnchorSet)
            ? this.spillOverflow(session, deliverableAnchorSet, false)
            : undefined;
        const anchorBlock = renderAnchors(deliverableAnchorSet, anchorOverflowUri);
        // Leading "\n\n", not just the heading itself (Codex review, PR #26
        // round 21): this is a NEW block appended after whatever the sidecar's
        // own last block ended with, which is never guaranteed to be a
        // newline. Without one, a later round's coalescedBlockText() (round
        // 20's own fix, joining directly-adjacent text blocks with NO
        // separator, matching what the provider actually sees) reconstructs
        // something like "...sidecar prose## Anchors..." — the heading no
        // longer starts a line, so anchorsFromCheckpoint()'s line-anchored
        // match (`^`) never recognizes it, and every deliverable this round
        // verified becomes unrecoverable on the next one. nativeFallback()'s
        // own equivalent append (above) already does this; this path
        // previously did not. A harmless extra blank line when the sidecar's
        // own text DID already end in one — ANCHOR_HEADING_LINE is multiline
        // (`m`), matching at the start of any line regardless of how many
        // blank ones precede it.
        const finalSummary = anchorBlock.length === 0 ? summary : [
            ...summary,
            { type: 'text', text: `\n\n${ANCHORS_BLOCK_HEADING}\n${anchorBlock}` },
        ];
        return {
            summary: finalSummary,
            provider: 'sidecar',
            model: this.adaptive.sidecar.endpoint,
        };
    }
    /**
     * Shared tail for every failOpen-eligible sidecar failure: log, then
     * either recover via `nativeFallback()` or propagate, per
     * `sidecar.failOpen`. The thrown-on-propagate error is a fresh
     * `SidecarRejectedError` rather than a rethrow of whatever caused this —
     * two of the three call sites (sha256 mismatch, missing anchors) detect
     * the problem locally with no original transport error to rethrow in the
     * first place, so a fresh, uniformly-shaped error is simpler than
     * preserving one only sometimes available.
     *
     * `rejectedReason` used to be hardcoded 'http' here regardless of the
     * caller (Codex review, PR #18 round 2): a caller inspecting the public
     * `SidecarRejectedError.reason` discriminator on a `failOpen: false`
     * rejection could not tell a retryable transport failure (timeout,
     * network, a real non-2xx status) from a locally detected, non-retryable
     * invalid response (bad hash, missing anchor, an unbuildable request) —
     * even though `SidecarClient` itself already classifies the former
     * correctly, one layer down. Each call site now passes the reason that
     * actually fits it.
     *
     * `status` is `undefined` for every call site except the one that
     * caught a real `SidecarRejectedError` from `SidecarClient` (Codex
     * review, PR #18 round 4): the OTHER two call sites (sha256 mismatch,
     * missing anchors) detect the problem locally, with no HTTP status to
     * have had in the first place. When a real one IS available, dropping
     * it here — even though `SidecarRejectedError.status` is part of the
     * class's own public shape — meant a `failOpen:false` caller could never
     * distinguish a retryable 429/503 from a permanent 4xx failure.
     */
    async sidecarFailOpen(input, agent, signal, reason, tag, rejectedReason, status) {
        this.ctx.logger.warn(`adaptive compaction: ${tag} — ${reason}`);
        if (!this.adaptive.sidecar.failOpen) {
            throw new SidecarRejectedError(`sidecar: ${reason}`, rejectedReason, status);
        }
        this.stats.sidecarFailOpens += 1;
        return this.nativeFallback(input, agent, signal, false);
    }
    /**
     * Pair the shadowed span with the source seqs `compactRegion()` recorded,
     * falling back to unaligned (`-1`-seq'd) messages when unavailable.
     * Shared by `buildAnchors()` and, for the sidecar path,
     * `sidecarSummarize()`'s own `SurfaceNode[]` request body — both need the
     * identical view of "what is being shadowed, and at what seq" rather than
     * two independently-derived copies that could drift.
     */
    shadowedNodesFor(session, input) {
        const seqs = this.pendingShadowed.get(session);
        // Falling back to the replayed messages loses provenance but keeps the
        // anchors; anchors are an enhancement, not a precondition for compacting.
        return seqs === undefined
            ? input.messages.map(message => ({ seq: -1, message }))
            : alignSeqsToMessages(session, seqs);
    }
    /**
     * @param maxLabel - forwarded to `artifactResolver()`; defaults to
     *   `'confidential'` (correct for the normal structured/prose paths — an
     *   anchor citing a secret URI has no business surviving into a checkpoint
     *   a cloud summarizer is about to see). The SEC-06 downgrade path passes
     *   `'secret'` explicitly: without it, `extractAnchors()`'s own
     *   `resolveArtifact` check excludes the secret URI at extraction time,
     *   before `anchorsOnlyResult()`'s later scrub fix ever gets a chance to
     *   matter — there would be nothing left to preserve.
     */
    buildAnchors(session, input, maxLabel) {
        if (!this.adaptive.anchors.enabled) {
            return extractAnchors([], { ...this.adaptive.anchors, budgetTokens: 0, enabled: false });
        }
        const nodes = this.shadowedNodesFor(session, input);
        const shadowedTokens = input.messages.reduce((total, message) => total + this.ctx.tokenMeter.estimateMessage(message), 0);
        const resolver = this.artifactResolver(session, maxLabel);
        const anchors = extractAnchors(nodes, {
            ...this.adaptive.anchors,
            budgetTokens: Math.max(0, Math.min(this.adaptive.anchors.maxTokens, Math.floor(shadowedTokens * this.adaptive.anchors.maxShareOfShadowed))),
            // Existence is not enough: a digest that leaked through a summary must
            // still be unreadable by a caller holding no reference to it.
            // Spread rather than assign: `exactOptionalPropertyTypes` treats an
            // explicit `undefined` as a different thing from an absent key.
            ...(resolver === undefined ? {} : { resolveArtifact: resolver }),
        });
        return this.withRetainedTailChronology(session, anchors);
    }
    /**
     * Extends `anchors.lastAssistantSeq` to also cover a qualifying answer
     * sitting in the RETAINED tail, not just the shadowed range
     * `extractAnchors()` itself scanned (Codex review, PR #26 round 16).
     * `selectAdaptiveRange()` (range.ts) picks its cut purely by token
     * budget (plus checkpoint-absorption and tool-pairing balance) — nothing
     * checks "does this cut split a question from its own answer," so a
     * deliverable asked in the shadowed prefix can have its own answer land
     * in the retained tail instead. `unresolvedDeliverables()` (anchors.ts)
     * would otherwise see only the shadowed-side maximum, conclude no
     * assistant turn followed the question, and force it open even though
     * the model can still see it answered, right there in its own current
     * context — worse, that forced reopening overrides EVEN a genuine
     * `trackedLabels` match (the chronology check short-circuits before
     * `trackedLabels` is ever consulted), so this was not just a redundant
     * nudge but one capable of prompting duplicate work.
     *
     * Only attempted with real alignment (`pendingShadowed` set) — the same
     * seqs `shadowedNodesFor()` itself needed to build `nodes` above; with no
     * alignment there is no reliable way to know which real seqs the
     * shadowed range even corresponds to, so there is nothing to compute a
     * "retained tail" relative to (matches the existing `seq !== -1` guard
     * `unresolvedDeliverables()` already applies for the identical reason).
     * Reads `session.surface.nodes` — the CURRENT, pre-commit surface,
     * shadowed and retained portions both still present; this method only
     * ever runs from within `summarize()`, before upstream replaces the
     * shadowed span with the checkpoint.
     *
     * "Retained" is a POSITIONAL question — everything `session.surface.nodes`
     * places after the shadowed range, in the model-visible order that array
     * itself is documented to carry — not a numeric one (Codex review, PR
     * #26 round 20, a real gap: `compactRegion()`, which built
     * `pendingShadowed` in the first place, already uses the identical
     * positional `indexOf`/`slice` pattern below for the exact same reason).
     * A prior compaction's own checkpoint gets a seq assigned at APPEND
     * time — a large number, since many other events already existed by
     * then — while sitting, POSITIONALLY, where the range it replaced used
     * to be, ahead of events that already existed back then and kept their
     * own, much LOWER seqs. Comparing raw seq magnitude (`seq >
     * lastShadowedSeq`, the old check) silently drops exactly those
     * low-seq/late-position original events from "retained" the moment a
     * LATER round's shadowed range includes that earlier checkpoint — if
     * one of them is the genuine delivered answer to a question the
     * checkpoint itself carries forward, this method concludes there is
     * nothing to extend `lastAssistantSeq` with and the question gets
     * force-reopened despite the model still seeing it answered, right
     * there in its own current context.
     */
    withRetainedTailChronology(session, anchors) {
        const shadowedSeqs = this.pendingShadowed.get(session);
        if (shadowedSeqs === undefined || shadowedSeqs.length === 0)
            return anchors;
        const nodes = session.surface.nodes;
        // `shadowedSeqs` is itself a positionally-contiguous slice of `nodes`
        // as of when `compactRegion()` captured it (`nodes.slice(from, to +
        // 1)`) — its own last element is therefore the positionally-last
        // shadowed seq, with no need to re-derive position for every entry.
        const lastShadowedIndex = nodes.indexOf(shadowedSeqs[shadowedSeqs.length - 1]);
        if (lastShadowedIndex === -1)
            return anchors;
        const retainedSeqs = nodes.slice(lastShadowedIndex + 1);
        if (retainedSeqs.length === 0)
            return anchors;
        const retainedLastAssistantSeq = alignSeqsToMessages(session, retainedSeqs)
            .filter(node => isDeliveredAnswer(node.message))
            .reduce((max, node) => Math.max(max, node.seq), -Infinity);
        if (retainedLastAssistantSeq === -Infinity)
            return anchors;
        if (anchors.lastAssistantSeq !== undefined && anchors.lastAssistantSeq >= retainedLastAssistantSeq) {
            return anchors;
        }
        return { ...anchors, lastAssistantSeq: retainedLastAssistantSeq };
    }
    /**
     * Whether this session may resolve a given artifact URI.
     *
     * Existence is not enough: a digest that leaked through a summary must still
     * be unreadable by a caller holding no reference to it, so this asks
     * `references()` and never `statBlob()`. Returns undefined when there is no
     * store to ask, which disables filtering rather than rejecting everything.
     *
     * @param session - the reader.
     * @returns a resolver, or undefined when no store is composed.
     */
    /**
     * Redact credentials in text before it is committed or sent.
     *
     * The artifact store redacts on WRITE, which covers exactly one of the four
     * sinks the security model names — artifact, embedding, summarization,
     * surface. A checkpoint is the surface sink, and it is the most durable one:
     * a token that appears in transient tool output is gone after compaction,
     * while a token copied into a checkpoint stays in the session's memory for
     * the rest of its life. The same pass covers a replayed system prompt, one
     * of the two halves `redactMessages` (the other) does not reach.
     *
     * SEC-02 is what made this concrete. A well-behaved model correctly refused
     * an injected instruction and then, being helpful, REPORTED the attack —
     * reproducing the credential verbatim while explaining why it was ignoring
     * it. Instruction-following defence worked; data minimization did not exist.
     *
     * Pattern-based, so it catches known credential shapes and nothing else. It
     * is a last line, not a guarantee.
     *
     * @param text - the rendered checkpoint body, or a replayed system prompt.
     * @param context - names what `text` is, for the warn log only.
     * @returns the body with recognised credentials replaced by markers.
     */
    redact(text, context = 'a checkpoint') {
        const outcome = redactText(text);
        const hits = Object.entries(outcome.hits);
        if (hits.length > 0) {
            // Counts only — logging the match would defeat the redaction.
            this.ctx.logger.warn(`adaptive compaction: redacted credentials in ${context}: `
                + hits.map(([rule, count]) => `${rule}×${count}`).join(', '));
        }
        return outcome.text;
    }
    /**
     * Redact assembled summary/raw-output blocks before durable storage.
     * Same-type text runs share a pattern boundary; reasoning, non-text blocks,
     * and nested result arrays remain distinct. Preserve block order/types and
     * every non-content field, including on a rewritten run. Unknown payloads
     * and metadata are deliberately outside this known-field redaction scope.
     *
     * Clean runs retain identity. For a changed run, prefer independent block
     * rewrites when they equal the authoritative joined rewrite. Otherwise keep
     * the unchanged prefix/suffix at their source offsets and put the changed
     * middle in its first affected block. This preserves the aggregate text and
     * metadata fields, not character-level provenance within a changed middle.
     * Inputs are never mutated; only known tool arguments/results are traversed.
     */
    redactRawBlocks(blocks) {
        const hits = {};
        const record = (outcome) => {
            for (const [rule, count] of Object.entries(outcome.hits))
                hits[rule] = (hits[rule] ?? 0) + count;
        };
        const redactBlocks = (input) => {
            let changed = false;
            const out = [];
            let run = [];
            const flushRun = () => {
                if (run.length === 0)
                    return;
                const original = run.map(block => block.text).join('');
                const outcome = redactText(original);
                if (Object.keys(outcome.hits).length === 0) {
                    for (const block of run)
                        out.push(block);
                    run = [];
                    return;
                }
                record(outcome);
                // These trial scans do not contribute log counts: the joined
                // pass alone determines the matches and final text.
                let texts = run.map(block => redactText(block.text).text);
                if (texts.join('') !== outcome.text) {
                    let prefix = 0, suffix = 0;
                    while (prefix < original.length && prefix < outcome.text.length
                        && original[prefix] === outcome.text[prefix])
                        prefix += 1;
                    const splitsPair = (text, offset) => offset > 0 && offset < text.length
                        && /[\uD800-\uDBFF]/.test(text[offset - 1])
                        && /[\uDC00-\uDFFF]/.test(text[offset]);
                    while (splitsPair(original, prefix) || splitsPair(outcome.text, prefix))
                        prefix -= 1;
                    while (suffix < original.length - prefix && suffix < outcome.text.length - prefix
                        && original[original.length - suffix - 1] === outcome.text[outcome.text.length - suffix - 1])
                        suffix += 1;
                    while (splitsPair(original, original.length - suffix)
                        || splitsPair(outcome.text, outcome.text.length - suffix))
                        suffix -= 1;
                    const end = original.length - suffix;
                    const middle = outcome.text.slice(prefix, outcome.text.length - suffix);
                    let offset = 0, inserted = false;
                    texts = run.map((block) => {
                        const start = offset;
                        offset += block.text.length;
                        if (offset <= prefix || start >= end || block.text.length === 0)
                            return block.text;
                        const head = block.text.slice(0, Math.max(0, prefix - start));
                        const tail = offset > end ? block.text.slice(end - start) : '';
                        const replacement = inserted ? '' : middle;
                        inserted = true;
                        return head + replacement + tail;
                    });
                }
                for (let i = 0; i < run.length; i++) {
                    if (texts[i] === run[i].text)
                        out.push(run[i]);
                    else {
                        changed = true;
                        out.push({ ...run[i], text: texts[i] });
                    }
                }
                run = [];
            };
            for (const block of input) {
                if (block.type === 'text' || block.type === 'reasoning') {
                    if (run.length > 0 && run[0].type !== block.type)
                        flushRun();
                    run.push(block);
                    continue;
                }
                flushRun();
                let next = block;
                if (block.type === 'tool-result') {
                    const content = redactBlocks(block.content);
                    if (content !== block.content)
                        next = { ...block, content };
                }
                else if (block.type === 'tool-call') {
                    const outcome = redactText(block.arguments);
                    if (Object.keys(outcome.hits).length > 0) {
                        record(outcome);
                        next = { ...block, arguments: outcome.text };
                    }
                }
                if (next !== block)
                    changed = true;
                out.push(next);
            }
            flushRun();
            return changed ? out : input;
        };
        const result = redactBlocks(blocks);
        if (Object.keys(hits).length > 0) {
            this.ctx.logger.warn('adaptive compaction: redacted credentials in assembled output blocks: '
                + Object.entries(hits).map(([rule, count]) => `${rule}×${count}`).join(', '));
        }
        return result;
    }
    /**
     * Redact credentials from replayed tool definitions before they reach the
     * summarization provider.
     *
     * `SummarizationInput.tools` is typed `readonly unknown[]`, not a known
     * schema shape, deliberately: a dynamic description, a schema `default`,
     * or an example value can all carry a recognized credential, and there is
     * no single field to single out the way `arguments` is for a tool CALL.
     * Walks every string leaf of the whole structure — objects, arrays, and
     * scalars alike — redacting in place rather than trying to name specific
     * fields, so a provider whose schema shape this file has never seen still
     * gets the same coverage.
     *
     * @param tools - replayed tool definitions, never mutated.
     * @returns the same array when nothing matched, otherwise a deep copy
     *   with only the affected string values replaced.
     */
    redactToolDefinitions(tools) {
        const hits = {};
        const record = (valueHits) => {
            for (const [rule, count] of Object.entries(valueHits)) {
                hits[rule] = (hits[rule] ?? 0) + count;
            }
        };
        const redactValue = (value) => {
            if (typeof value === 'string') {
                const outcome = redactText(value);
                if (Object.keys(outcome.hits).length === 0)
                    return value;
                record(outcome.hits);
                return outcome.text;
            }
            if (Array.isArray(value)) {
                const next = value.map(redactValue);
                return next.some((entry, i) => entry !== value[i]) ? next : value;
            }
            if (value !== null && typeof value === 'object') {
                let changed = false;
                const next = {};
                for (const [key, entry] of Object.entries(value)) {
                    const redacted = redactValue(entry);
                    if (redacted !== entry)
                        changed = true;
                    next[key] = redacted;
                }
                return changed ? next : value;
            }
            return value;
        };
        const next = tools.map(redactValue);
        if (Object.keys(hits).length > 0) {
            // Counts only — logging the match would defeat the redaction.
            this.ctx.logger.warn(`adaptive compaction: redacted credentials in replayed tool definitions: `
                + Object.entries(hits).map(([rule, count]) => `${rule}×${count}`).join(', '));
        }
        return next.some((entry, i) => entry !== tools[i]) ? next : tools;
    }
    /**
     * Redact credentials from the replayed prefix before it reaches the
     * summarization provider.
     *
     * This is the summarization sink `redact()`'s own doc names as one of the
     * four the security model covers, and until now nothing implemented it:
     * `redact()` above only scrubs the checkpoint this engine PRODUCES, never
     * the conversation prefix `streamSummary` sends as input. tool-result-
     * offload's own redaction runs solely inside `compose()`, which only fires
     * for content that gets pruned — a tool result that stayed under that
     * threshold is never redacted anywhere upstream, so it would reach this
     * call's provider exactly as the tool produced it.
     *
     * "Already sent to the routed provider" is not "already sent to every
     * provider": `summarizationProvider`/`summarizationModel` can name a route
     * distinct from the one actually serving the conversation, and even the
     * same-provider case is not guaranteed prior exposure — compaction can
     * trigger before a credential-bearing result is ever replayed back to the
     * model on its own. Text, reasoning, and tool-call-argument content, walking
     * into nested tool-result content: SEC-02 showed a model's own narration
     * can reproduce a credential verbatim while explaining why it refused to
     * use it, so reasoning carries the same risk as visible text — and a
     * credential is a completely ordinary tool ARGUMENT (an api_key parameter,
     * say), not just something a model might narrate. Images are the one
     * block left alone: a provider needs the raw bytes to replay a request
     * faithfully, and there is no text-shaped surface to redact within one.
     * Tool-call arguments are redacted per block, not run-combined the way
     * text/reasoning are — each call's `arguments` is one self-contained JSON
     * string, not prose arbitrarily chunked across adjacent blocks, so there
     * is no adjacent-fragment split to guard against.
     *
     * Runs of consecutive text/reasoning blocks are redacted as ONE combined
     * string, not block by block — matching tool-result-offload's own fix for
     * the identical failure mode. A credential split across two adjacent
     * blocks (an artifact of how the content happened to be chunked, not a
     * real boundary) would otherwise match in neither fragment alone: the
     * api_key pattern needs 20+ chars after `sk-`, and splitting it anywhere
     * makes both halves too short, even though the two are directly adjacent
     * once rendered back out. Combining stops at any non-text block, a
     * message boundary, or a `text`/`reasoning` type change — real,
     * observable separators this function must not merge across. Type
     * changes matter because the combined replacement keeps only the first
     * block's own `type`: merging a `reasoning` block into a `text` run (or
     * the reverse) would silently reclassify a provider-visible answer as
     * hidden reasoning, or the reverse — a correctness bug, not a cosmetic
     * one, this redaction pass has no business introducing on its own.
     *
     * Breaks exact-prefix cache reuse for a turn whose content actually gets
     * rewritten (the redacted text is no longer byte-identical to what the
     * routed provider already has cached) — an accepted cost, not an oversight;
     * the alternative is a provider receiving a live credential this pipeline
     * could have caught.
     *
     * @param messages - the replayed prefix, never mutated.
     * @returns the same array when nothing matched, otherwise a shallow copy
     *   with only the affected messages and blocks replaced.
     */
    redactMessages(messages) {
        const hits = {};
        const record = (blockHits) => {
            for (const [rule, count] of Object.entries(blockHits)) {
                hits[rule] = (hits[rule] ?? 0) + count;
            }
        };
        const redactBlocks = (blocks) => {
            let changed = false;
            const out = [];
            let run = [];
            const flushRun = () => {
                if (run.length === 0)
                    return;
                const outcome = redactText(run.map(block => block.text).join(''));
                if (Object.keys(outcome.hits).length === 0) {
                    out.push(...run);
                }
                else {
                    record(outcome.hits);
                    changed = true;
                    out.push({ ...run[0], text: outcome.text });
                }
                run = [];
            };
            for (const block of blocks) {
                if (block.type === 'text' || block.type === 'reasoning') {
                    // A type change ends the run just like a non-text block does: the
                    // combined replacement below takes its `type` from `run[0]`, so
                    // merging a `reasoning` block into a `text` run (or the reverse)
                    // would silently reclassify one as the other. Provider-visible
                    // text hidden as reasoning (or the reverse) is a correctness bug
                    // this redaction pass has no business introducing on its own.
                    if (run.length > 0 && run[0].type !== block.type)
                        flushRun();
                    run.push(block);
                    continue;
                }
                flushRun();
                if (block.type === 'tool-result') {
                    const content = redactBlocks(block.content);
                    if (content === block.content) {
                        out.push(block);
                    }
                    else {
                        changed = true;
                        out.push({ ...block, content });
                    }
                }
                else if (block.type === 'tool-call') {
                    const outcome = redactText(block.arguments);
                    if (Object.keys(outcome.hits).length === 0) {
                        out.push(block);
                    }
                    else {
                        record(outcome.hits);
                        changed = true;
                        out.push({ ...block, arguments: outcome.text });
                    }
                }
                else {
                    out.push(block);
                }
            }
            flushRun();
            return changed ? out : blocks;
        };
        let changed = false;
        const next = messages.map((message) => {
            const content = redactBlocks(message.content);
            if (content === message.content)
                return message;
            changed = true;
            return { ...message, content };
        });
        if (Object.keys(hits).length > 0) {
            // Counts only — logging the match would defeat the redaction.
            this.ctx.logger.warn(`adaptive compaction: redacted credentials in the replayed summarization prefix: `
                + Object.entries(hits).map(([rule, count]) => `${rule}×${count}`).join(', '));
        }
        return changed ? next : messages;
    }
    /**
     * A second, wire-level redaction pass for the sidecar transport, ON TOP
     * of (not instead of) redactMessages()/redactRawBlocks() above — one
     * call on each outbound WireSurfaceNode.content, one call on an inbound
     * response's `summary` before fromWireContentBlocks() converts it.
     *
     * redactMessages()'s own domain-level coalescing deliberately keeps a
     * `text` block and an adjacent `reasoning` block as SEPARATE redaction
     * runs — its own comment explains why: merging them would silently
     * reclassify one as the other, a correctness bug for every other caller
     * of that method, which is not otherwise wire-bound. toWireContentBlocks()
     * then erases exactly that distinction (both map to wire `type: 'text'`,
     * pushed as separate, unjoined array entries) — so a credential split
     * across that specific boundary survived the domain pass and landed in
     * two adjacent, now-indistinguishable wire blocks (Codex review, PR #18
     * round 2). A sidecar response has the identical shape after
     * fromWireContentBlocks() (which never emits `reasoning` — everything
     * becomes domain `text`) — and the wire protocol permits arbitrary
     * response block boundaries, which sidecarSummarize()'s own anchors
     * check already treats as contiguous via coalescedBlockText(); this
     * closes the same gap for redaction, on both sides of the wire.
     *
     * Coalesces only on an actual hit, exactly like redactMessages()'s own
     * flushRun — a clean run is returned as its original, untouched blocks,
     * not unconditionally rebuilt.
     */
    coalesceRedactWire(blocks) {
        const hits = {};
        const out = [];
        let run = [];
        const flushRun = () => {
            if (run.length === 0)
                return;
            const outcome = redactText(run.map(block => block.text ?? '').join(''));
            if (Object.keys(outcome.hits).length === 0) {
                out.push(...run);
            }
            else {
                for (const [rule, count] of Object.entries(outcome.hits))
                    hits[rule] = (hits[rule] ?? 0) + count;
                out.push({ type: 'text', text: outcome.text });
            }
            run = [];
        };
        for (const block of blocks) {
            // 'code' included alongside 'text': fromWireContentBlocks() treats
            // both identically (both become a domain TextBlock), and an inbound
            // response's summary — unlike an outbound surface, which
            // toWireContentBlocks() never emits 'code' into — can legitimately
            // mix the two.
            if ((block.type === 'text' || block.type === 'code') && block.text !== undefined) {
                run.push(block);
                continue;
            }
            flushRun();
            out.push(block);
        }
        flushRun();
        if (Object.keys(hits).length > 0) {
            this.ctx.logger.warn(`adaptive compaction: redacted credentials split across adjacent sidecar wire blocks: `
                + Object.entries(hits).map(([rule, count]) => `${rule}×${count}`).join(', '));
        }
        return out;
    }
    /**
     * Neutralizes an anchor-impersonating heading across ADJACENT text/
     * reasoning block boundaries, not each domain block independently
     * (Codex review, PR #26 round 21): `coalesceRedactWire()` above only
     * merges a run of adjacent WIRE blocks when a credential was found
     * inside their joined text — an impersonating `"## Anchors"` heading is
     * not credential-shaped, so a sidecar splitting that exact string
     * across two blocks sails through `coalesceRedactWire()` untouched,
     * handed back as the same two separate blocks; each half, alone, is
     * short of the full heading `neutralizeAnchorImpersonation()` matches
     * against, so the OLD per-block `.map()` this replaces never caught it
     * either. `coalescedBlockText()` — used to re-read a checkpoint's text
     * on the NEXT round, and by the provider itself — joins directly-
     * adjacent blocks with NO separator, reconstructing the exact, intact,
     * never-neutralized heading from the two halves: anchorsFromCheckpoint()
     * then trusts it, and everything shaped like an anchor line right after
     * it, exactly like a genuine local rendering. Mirrors
     * `coalesceRedactWire()`'s own run-then-decide shape: a run that didn't
     * need rewriting is returned exactly as given, not needlessly collapsed.
     */
    neutralizeAcrossBlocks(blocks) {
        const out = [];
        let run = [];
        const flushRun = () => {
            if (run.length === 0)
                return;
            const joined = run.map(block => (block.type === 'text' || block.type === 'reasoning' ? block.text : '')).join('');
            const neutralized = neutralizeAnchorImpersonation(joined);
            if (neutralized === joined) {
                out.push(...run);
            }
            else {
                out.push({ type: 'text', text: neutralized });
            }
            run = [];
        };
        for (const block of blocks) {
            if (block.type === 'text' || block.type === 'reasoning') {
                run.push(block);
                continue;
            }
            flushRun();
            out.push(block);
        }
        flushRun();
        return out;
    }
    /**
     * @param maxLabel - defaults to `'confidential'` (via `principalFor()`'s own
     *   default), which is correct for every caller except `anchorsOnlyResult()`
     *   (SEC-06): that path passes `'secret'` explicitly, because scrubbing a
     *   secret-labelled URI out of a downgraded checkpoint with the default
     *   ceiling would erase the one marker a later compaction pass needs to
     *   recognise this checkpoint as still carrying secret provenance — this
     *   resolver exists to catch hallucinated/inaccessible URIs, not to
     *   re-apply a label ceiling to a reference this engine already verified
     *   moments ago while deciding to downgrade.
     */
    artifactResolver(session, maxLabel) {
        const store = this.ctx.get('artifactStore');
        // The store issues the principal: a literal tenant here would disagree with
        // a store configured for any other tenant, and every real URI would then be
        // written off as hallucinated.
        const principal = store?.principalFor(session.id, maxLabel);
        if (store === undefined || principal === undefined)
            return undefined;
        return uri => (store.references(uri, principal).length > 0 ? uri : undefined);
    }
    /**
     * The provider/model summarization would route to right now.
     *
     * The same "explicit config, then last-routed, then AgentOptions fallback"
     * chain `streamSummary()` uses for its own call, extracted so the SEC-06
     * gate can ask the question before either `summarize()` branch commits to
     * a model call, without a second inline copy of the fallback.
     */
    resolveSummarizationTarget(agent) {
        const latest = routedTarget(agent.session);
        const configured = this.config.summarizationProvider.length === 0
            ? undefined
            : { provider: this.config.summarizationProvider, model: this.config.summarizationModel };
        const fallback = agent.options.provider !== undefined && agent.options.provider.length > 0
            && agent.options.model !== undefined && agent.options.model.length > 0
            ? { provider: agent.options.provider, model: agent.options.model }
            : undefined;
        return configured ?? latest ?? fallback;
    }
    /**
     * Whether any artifact reference visible in `input` is labelled `secret`
     * for this session.
     *
     * `input` is the exact replayed prefix this summarization call was handed
     * — SEC-06's "this context", not the full session log: a reference
     * shadowed by an earlier compaction and no longer replayed is not part of
     * what this call would send anywhere.
     *
     * Scans `input.system`, `input.tools`, the coalesced text of every
     * message (adjacent `text`/`reasoning` blocks joined with no separator,
     * including inside `tool-result` blocks — Codex review round 4: a
     * `JSON.stringify()`-only scan inserts JSON syntax between two blocks
     * that together spell one URI, exactly the "adjacent-block fragmentation"
     * shape `redactMessages()` already treats as real for the identical
     * reason), AND the full `JSON.stringify()` of every message on top of
     * that (catches a URI inside a single field `coalescedText()` does not
     * walk, e.g. a `tool-call` block's own `arguments` string, and stays
     * correct if a future `ContentBlock` kind is added — merge-extensible per
     * its own doc comment).
     *
     * A prior `<!-- secret-provenance: true -->` marker on a GENUINE earlier
     * checkpoint counts as secret on its own (Codex review round 4): an
     * artifact reference can expire or be swept (`ArtifactStore`'s own
     * `retainForMs` — see ST-08's sweep tests), at which point
     * `store.labelOf()` stops returning `'secret'` for a URI that was
     * genuinely secret when this checkpoint was first written. Re-deriving
     * secrecy from a live store lookup on every pass would silently un-taint
     * an already-marked checkpoint the moment its artifact expires; the
     * marker's own presence in already-committed, durable session history is
     * the source of truth from that point on, not a fresh lookup.
     *
     * "GENUINE" is load-bearing (Codex review round 5, P2): the marker check
     * is scoped to messages `isCompactCheckpointSource()` recognises as this
     * package's own checkpoints, not a substring scan of arbitrary replayed
     * text. Untrusted tool or web output could otherwise plant the literal
     * marker string and force every later pass onto the degraded
     * anchors-only path — the same "trust the source, not the pattern"
     * principle SEC-02's own anchor-extraction already applies to directives
     * appearing in tool output.
     *
     * KNOWN GAP (Codex review round 5, deferred by user decision rather than
     * fixed here): `@adaptive-compact/dsh-tool-result-offload`'s own
     * `toolPolicies[].securityLabel: 'secret'` has no effect on this check
     * when that policy also uses `mode: 'keep'` or the result is below
     * `thresholdChars` — `pruneContent()` returns the redacted blocks inline
     * with no artifact URI and no marker in either case, so neither signal
     * this function looks for exists. This is a real gap in
     * `tool-result-offload` itself, not something a wider scan here could
     * close: there is no metadata slot on `ContentBlock` to carry a security
     * label inline, and this package deliberately does not depend on
     * `tool-result-offload` (see that package's own `package.json` — no
     * relationship exists either direction today). Two fix directions were
     * considered and both have real costs: forcing an artifact write for
     * `securityLabel: 'secret'` policies regardless of `mode`/`thresholdChars`
     * overrides `mode: 'keep'`'s own deliberate meaning; having
     * `tool-result-offload` emit this same marker text for inline content
     * would need a new way to distinguish "genuinely from that package's own
     * redaction" from "an attacker planted this text in raw tool output" —
     * not solvable with `MessageSource`'s current shape. Left for a
     * follow-up with its own design pass.
     */
    isSecretTainted(session, input) {
        const hasGenuineMarker = input.messages.some(message => (isCompactCheckpointSource(message.source)
            && coalescedBlockText(message.content).includes(SECRET_PROVENANCE_MARKER)));
        if (hasGenuineMarker)
            return true;
        const text = [
            input.system ?? '',
            input.tools === undefined ? '' : JSON.stringify(input.tools),
            input.messages.map(m => coalescedBlockText(m.content)).join('\n'),
            JSON.stringify(input.messages),
        ].join('\n');
        const store = this.ctx.get('artifactStore');
        if (store === undefined)
            return false;
        const principal = store.principalFor(session.id, 'secret');
        return findArtifactUris(text).some(uri => store.labelOf(uri, principal) === 'secret');
    }
    /**
     * Appends the durable secret-provenance marker as its own content block
     * whenever `tainted` (SEC-06, Codex review round 3/4) — deliberately
     * independent of whatever `anchors` ends up containing. Anchors are
     * optional (`anchors.enabled`), kind-filtered (`anchors.kinds` need not
     * include `'artifacts'`), and budget-limited (`ANCHOR_PRIORITY` can evict
     * a lower-priority anchor under pressure) — none of which this marker
     * depends on. Prose mode (which never calls `buildAnchors()` at all,
     * since it delegates entirely to `super.summarize()`) needs this the same
     * as the structured path.
     *
     * `SECRET_PROVENANCE_MARKER` is a fixed, constant-size sentinel — NOT a
     * list of the actual secret artifact URIs (Codex review round 4): a
     * session that has touched many unique secret artifacts must not produce
     * a checkpoint whose size grows with how many, and (per `isSecretTainted`
     * above) the marker needs to stay recognisable after those URIs' own
     * references have expired, at which point listing them would be citing
     * references nothing can resolve any more anyway.
     */
    withSecretProvenance(summary, tainted) {
        if (!tainted)
            return summary;
        return [...summary, { type: 'text', text: SECRET_PROVENANCE_MARKER }];
    }
    /**
     * Whether this summarization call must be downgraded to the zero-model-call
     * anchors-only path (SEC-06): `hasSecret` is true (the context being
     * compacted carries secret-labelled content, already computed once by the
     * caller), AND the target this call would otherwise route to is not on
     * `security.localProviders`.
     *
     * An unresolvable target also counts as "not local" — it is certainly not
     * on the allowlist — so a secret-carrying context degrades to anchors-only
     * instead of `streamSummary()`'s own "no provider/model available" throw.
     *
     * @returns a human-readable reason for the log line, or undefined when
     *   summarization may proceed through the normal branches.
     */
    secretDowngradeReason(agent, hasSecret) {
        if (!hasSecret)
            return undefined;
        const target = this.resolveSummarizationTarget(agent);
        if (target !== undefined && this.adaptive.security.localProviders.includes(target.provider)) {
            return undefined;
        }
        return 'this context contains secret-labelled content and the resolved summarization target '
            + `(${target === undefined ? 'none resolvable' : `${target.provider}/${target.model}`}) is not `
            + `in security.localProviders (${this.adaptive.security.localProviders.join(', ') || '(empty)'})`;
    }
    /**
     * An empty structured document plus the extracted anchors, no model text.
     *
     * Shared by `anchorsOnlyResult()` (SEC-06's zero-model-call degrade, below)
     * and `proseFallback()` (the pre-existing parse-error degrade, which
     * appends the model's own prose after this same block).
     *
     * @param overflowUri - cited in the rendered anchors block the same way
     *   the normal structured path's own `renderSummary()` call does.
     *   `proseFallback()`'s own caller now spills before calling it (Codex
     *   review, PR #26 round 12, closing a gap this parameter's own doc used
     *   to note as "out of scope" here) — an overflowed deliverable that the
     *   malformed model prose also omits otherwise had no recovery pointer at
     *   all, even when an artifact store was available and would have
     *   produced one, matching every other path this whole mechanism already
     *   covers.
     */
    anchorsOnlyBody(anchors, overflowUri) {
        return renderSummary({
            schema_version: this.adaptive.summary.schemaVersion,
            task_state: { goal: '', current_plan: [], completed: [], open: [] },
            decisions: [], files: [], tests: [], errors: [],
            critical_facts: [], user_constraints: [], next_step: '', artifact_refs: [],
        }, anchors, this.adaptive.summary.schemaVersion, overflowUri, undefined, {compact: this.adaptive.summary.compactRendering});
    }
    /**
     * The zero-model-call SEC-06 degrade: an anchors-only checkpoint body, with
     * no `ctx.llm.stream()` call at all.
     *
     * `provider`/`model` are sentinel strings, not the declined target:
     * upstream's `commitCompactionBody()` records these two fields into the
     * durable `compaction/summary` event with no further validation — citing
     * the declined cloud target here would misleadingly read as if it had
     * actually been called.
     *
     * Spills truncated anchors the same way the normal structured path does
     * (Codex review round 7): without this, a secret-tainted context whose
     * anchors exceed the budget would have the evicted ones — commands,
     * files, artifact references — silently and permanently discarded, since
     * this degrade has no model call to fall back on for that content. The
     * spilled artifact is labelled `'secret'`, matching `spillOverflow()`'s
     * own round-5 fix.
     */
    anchorsOnlyResult(session, anchors) {
        const overflowUri = this.spillOverflow(session, anchors, true);
        return {
            summary: [{
                    type: 'text',
                    text: this.redact(scrubUnresolvableUris(this.anchorsOnlyBody(anchors, overflowUri), this.artifactResolver(session, 'secret'))),
                }],
            provider: 'none',
            model: 'anchors-only',
        };
    }
    /**
     * Run the optional model-free reduction.
     *
     * One posture for every caller. The three call sites previously differed —
     * two let a pruner failure escape and one swallowed it — so whether a
     * `fallbackToTruncate: false` pruner killed the turn depended on which path
     * happened to reach it. Pruning is an optimization: its failure is never
     * worth losing a turn over, and the compaction that follows still works on
     * unpruned history.
     *
     * @returns how many tool results were replaced; 0 when the pruner is absent.
     */
    reduce(session, phase) {
        const prune = this.ctx.get('toolResultPruner');
        if (prune === undefined)
            return 0;
        try {
            const result = prune.pruneSession(session);
            if (result.pruned.length > 0) {
                this.ctx.logger.info(`adaptive compaction (${phase}): pruned ${result.pruned.length} tool results, `
                    + `${result.charsRemoved} chars removed`);
            }
            return result.pruned.length;
        }
        catch (error) {
            this.ctx.logger.warn(`adaptive compaction (${phase}): tool-result pruning failed, continuing `
                + `on unpruned history: ${String(error)}`);
            return 0;
        }
    }
    /** Spill budget-dropped anchors to an artifact so they remain recoverable. */
    /**
     * @param secret - SEC-06, Codex review round 5: the evicted anchors this
     *   spills can themselves be secret-derived (errors, commands, or
     *   artifact references extracted from secret-labelled content this pass
     *   was allowed to see locally) — a hardcoded `'internal'` label would
     *   make the resulting artifact readable to lower-clearance principals
     *   AND eligible for `context-retrieval`'s own embedding path (which
     *   specifically exempts `'secret'`, not `'internal'`), reopening the
     *   exact leak this whole feature exists to close, one hop removed.
     */
    spillOverflow(session, anchors, secret) {
        if (!isTruncated(anchors))
            return undefined;
        const store = this.ctx.get('artifactStore');
        if (store === undefined)
            return undefined;
        try {
            // tenantId omitted deliberately: the store fills in its own, so overflow
            // lands in the same reference scope as the session's other artifacts.
            const put = store.putSync(renderOverflow(anchors), {
                sessionId: session.id, securityLabel: secret ? 'secret' : 'internal',
            });
            // Codex review, PR #26 round 19: `putSync()` can succeed while still
            // cutting the body short — `put.reference.truncated` — whenever the
            // store's own `maxArtifactBytes` ceiling is smaller than the
            // rendered overflow body. The old code took only `.uri`, so a
            // truncated artifact was cited as the SAME "full text" recovery
            // pointer for every overflowed deliverable regardless of whether
            // its own content actually survived the cut — worse than no pointer
            // at all, since nothing re-verifies the stored bytes against an
            // anchor's text on a later round; I12 was only ever checked once,
            // against the pre-truncation string, at spill time. Treat a
            // truncated spill as a failed one: every caller below already knows
            // how to render "not stored" instead of a URI when this is
            // `undefined`. (`PutResult.truncated` does not exist at the top
            // level — it is nested on `PutResult.reference`, the stored
            // `ArtifactReference` — a `PutResult` also carries an unrelated
            // top-level `.blob`, easy to mis-read as the whole result.)
            if (put.reference.truncated) {
                this.ctx.logger.warn('adaptive compaction: anchor overflow artifact exceeded the store\'s maxArtifactBytes and was '
                    + 'truncated; not citing it as a recovery pointer for anchors it may no longer fully contain');
                return undefined;
            }
            return put.uri;
        }
        catch (error) {
            this.ctx.logger.warn(`adaptive compaction: could not spill anchor overflow: ${String(error)}`);
            return undefined;
        }
    }
    proseFallback(text, anchors, overflowUri) {
        // Anchors first, then whatever the model actually wrote.
        return `${this.anchorsOnlyBody(anchors, overflowUri)}\n\n## Narrative (model-generated)\n${neutralizeAnchorImpersonation(text.trim())}`;
    }
    result(raw, summary) {
        return {
            summary,
            // Both call sites already redact `summary` themselves before passing
            // it in; `rawOutput` is `raw.blocks` — the model's un-rendered
            // response, committed into the SAME durable compaction/summary event
            // as replay provenance (see redactRawBlocks' own doc) — and neither
            // call site has touched that yet.
            rawOutput: this.redactRawBlocks(raw.blocks),
            llmStreamCall: true,
            provider: raw.provider,
            model: raw.model,
            maxTokens: this.adaptive.maxTokens,
            ...(raw.usage === undefined ? {} : { usage: raw.usage }),
        };
    }
    /** One `ctx.llm.stream()` call with the replayed prefix plus the instruction. */
    async streamSummary(input, agent, signal, repair = false) {
        const target = this.resolveSummarizationTarget(agent);
        if (target === undefined) {
            throw new Error('adaptive compaction: no provider/model available for summarization; set both '
                + 'summarization fields, route one request, or set both AgentOptions fields');
        }
        const redacted = this.adaptive.summary.replayPrefix ? this.redactMessages(input.messages) : [];
        const prepared = this.adaptive.summary.foldToolRepeats
            ? foldToolRepeats(redacted, [input.system, input.tools]) : {messages: redacted, changedBlocks: 0};
        const deduped = this.adaptive.summary.dedupeToolPayloads
            ? dedupeToolPayloads(prepared.messages, [input.system, input.tools])
            : {messages: prepared.messages, references: 0};
        let baseInstruction = this.adaptive.summary.mode === 'flat'
            ? flatSummaryInstruction(this.adaptive.summary.schemaVersion, this.adaptive.maxTokens)
            : this.adaptive.summary.compactPrompt
            ? compactCompactionInstruction(this.adaptive.summary.schemaVersion, this.adaptive.maxTokens)
            : compactionInstruction(this.adaptive.summary.schemaVersion);
        if (prepared.changedBlocks > 0) {
            const rule = 'A marker [adaptive-repeat:v1 additional=N] means the immediately preceding complete line occurred N additional consecutive times; no unique line was omitted.';
            baseInstruction = this.adaptive.summary.compactPrompt
                ? baseInstruction.replace('Everything preceding this request', `${rule}\nEverything preceding this request`)
                : `${baseInstruction}\n${rule}`;
        }
        if (deduped.references > 0) baseInstruction += `\n${TOOL_PAYLOAD_REFERENCE_RULE}`;
        const instruction = repair
            ? `${baseInstruction}\n\nYour previous reply was not valid JSON. Return one valid JSON object only.`
            : baseInstruction;
        const groundedInstruction = this.adaptive.summary.verbatimFileArtifacts
            ? `${instruction}\nIn files[].artifact use only exact quotes from tool output; omit the field when no exact quote is available. Keep inferred plans in task_state instead.`
            : instruction;
        const messages = [
            ...deduped.messages,
            createUserMessage({
                content: [{ type: 'text', text: groundedInstruction }],
                source: { kind: 'plugin', plugin: 'dsh-compaction-adaptive' },
            }),
        ];
        const summarySystem = input.system === undefined || !this.adaptive.summary.replayPrefix
            ? undefined : this.redact(input.system, 'a replayed system prompt');
        // Groq JSON Object Mode rejects callable tool definitions. Historical
        // tool-call/result messages remain intact; normal requests are unaffected.
        const summaryTools = input.tools === undefined || !this.adaptive.summary.replayPrefix || this.adaptive.summary.jsonObject
            ? undefined : this.redactToolDefinitions(input.tools);
        const estimatedRequest = messages.reduce((sum, message) => sum + estimateMessage(message), 0)
            + (summarySystem ? Math.ceil(summarySystem.length / 4) + 4 : 0)
            + estimateToolsTokens({tools:summaryTools}) + this.adaptive.maxTokens;
        if (this.adaptive.budget.maxEstimatedSummaryRequestTokens > 0 && estimatedRequest > this.adaptive.budget.maxEstimatedSummaryRequestTokens) {
            this.stats.summaryBudgetRejected += 1;
            const error = new Error(`adaptive compaction: summary request estimate ${estimatedRequest} exceeds configured per-request budget ${this.adaptive.budget.maxEstimatedSummaryRequestTokens}`);
            error.code = 'SUMMARY_BUDGET_EXCEEDED'; throw error;
        }
        const assembler = new BlockAssembler();
        for await (const chunk of this.ctx.llm.stream({
            provider: target.provider,
            model: target.model,
            messages,
            ...(summarySystem === undefined ? {} : {system: summarySystem}),
            ...(summaryTools === undefined ? {} : {tools: summaryTools}),
            maxTokens: this.adaptive.maxTokens,
            sessionId: agent.session.id,
            purpose: 'compaction',
            ...(this.adaptive.summary.jsonObject ? {compactionJsonObject: true} : {}),
            // Optional unofficial schema metadata: unlike the official purpose
            // field, GenerateOptions does not define responseSchema. A
            // provider adapter that knows how to constrain generation to a JSON
            // schema reads this and does so; one that does not silently ignores
            // it, same as any other unrecognized property. See enforceSchema's
            // own doc in types.ts for why this exists (R27's residual gap) and
            // what was verified live before defaulting it on.
            ...(this.adaptive.summary.enforceSchema
                ? {
                    responseSchema: {
                        name: 'compaction_summary',
                        schema: this.adaptive.summary.mode === 'flat'
                            ? flatSummaryJsonSchema(this.adaptive.summary.schemaVersion)
                            : summaryDocumentJsonSchema(this.adaptive.summary.schemaVersion),
                    },
                }
                : {}),
            ...(signal === undefined ? {} : { signal }),
        })) {
            signal?.throwIfAborted();
            assembler.push(chunk);
        }
        signal?.throwIfAborted();
        const finish = assembler.finish;
        if (finish.kind === 'error' || finish.kind === 'aborted') {
            const error = new Error(finish.failure.message);
            error.code = finish.failure.code;
            throw error;
        }
        if (finish.kind === 'max-tokens') {
            // A truncated checkpoint is not a smaller checkpoint; it is a wrong one.
            const error = new Error('adaptive compaction: summarization was truncated at the token cap '
                + '(reasoning tokens count against it); raise maxTokens');
            error.code = 'MAX_TOKENS';
            throw error;
        }
        const blocks = assembler.blocks();
        const text = blocks
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('');
        if (text.trim().length === 0)
            throw new Error('adaptive compaction: summarization produced no text');
        return {
            // A model can quote our temporary encoding. Preserve its count in
            // plain language so the next epoch does not see a source collision
            // and permanently disable folding. Raw blocks retain provenance.
            text: prepared.changedBlocks > 0
                ? text.replace(/\[adaptive-repeat:v1 additional=(\d+)\]/g, '(previous line repeated $1 additional times)')
                : text,
            blocks,
            provider: target.provider,
            model: target.model,
            ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
        };
    }
    // ── manual compaction ────────────────────────────────────────────────────
    /**
     * Compact on request, below the automatic thresholds.
     *
     * Pruning takes its OWN idle admission before delegating. Upstream wraps
     * range selection, measurement and the whole transaction in
     * `agent.runMaintenance()`; calling `pruneSession()` outside that would commit
     * durable surface replacements on an agent that may be mid-turn, and then
     * report `busy` — a mutation with no admission behind it. Two sequential
     * admissions are not atomic, but the window between them is benign: the worst
     * case is the same `busy` a bare call would have produced, with the log
     * untouched.
     *
     * @param agent - the idle agent to compact.
     * @param signal - cancellation scoped to this request.
     * @param sourceCommandId - initiating command, for presentation.
     * @returns the committed result, or null when no useful span exists.
     */
    async compactNow(agent, signal, sourceCommandId) {
        signal.throwIfAborted();
        if (this.ctx.get('toolResultPruner') !== undefined && agent.runMaintenance !== undefined) {
            try {
                // reduce() runs INSIDE the admission, so a pruner failure is handled
                // there like everywhere else; this catch is only for failing to get the
                // admission at all.
                await agent.runMaintenance(async (agentSignal) => {
                    signal.throwIfAborted();
                    agentSignal.throwIfAborted();
                    this.reduce(agent.session, 'manual');
                });
            }
            catch (error) {
                // Failing to get admission is not a failure of /compact — it just means
                // this run skips the offload and lets summarization handle it.
                this.ctx.logger.warn(`adaptive compaction: manual prune skipped: ${String(error)}`);
            }
        }
        // Set as late as possible, not as this method's first statement (Codex
        // review, PR #18 finding 6): a manual request that super.compactNow()
        // is about to reject as busy (a concurrent compaction already holds the
        // admission) must not have already overwritten pendingTrigger for a
        // DIFFERENT, concurrently-running compactIfNeeded() pass on the same
        // session before being rejected. This narrows the window (the pruner
        // admission attempt above no longer runs "poisoned"); it does not fully
        // close it — if this call's own admission genuinely succeeds at the same
        // moment a concurrent pressure pass is between its own fresh set() and
        // its compactRegion() read, the two can still race. Closing that
        // completely would need a per-attempt id threaded through
        // RegionDependencies instead of a session-keyed WeakMap, which upstream
        // does not expose today — disproportionate for a residual window this
        // narrow (no intervening await on either side of the read it races).
        this.pendingTrigger.set(agent.session, 'manual');
        return super.compactNow(agent, signal, sourceCommandId);
    }
}
/** Exported under a test-only name: the behaviour is subtle enough to pin directly. */
export { addUsage as addUsageForTest };
/** Sum two provider usages, so a retried summarization reports what it cost. */
function addUsage(first, second) {
    if (first === undefined)
        return second;
    if (second === undefined)
        return first;
    const add = (a, b) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    const cacheRead = add(first.cacheReadTokens, second.cacheReadTokens);
    const cacheWrite = add(first.cacheWriteTokens, second.cacheWriteTokens);
    const reasoning = add(first.reasoningTokens, second.reasoningTokens);
    return {
        inputTokens: first.inputTokens + second.inputTokens,
        outputTokens: first.outputTokens + second.outputTokens,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    };
}
/** Upstream's own default, restated so the unreachable fallback is a real number. */
const DEFAULT_RETAIN_RATIO = 0.16;
export default AdaptiveCompactionEngine;
//# sourceMappingURL=index.js.map
