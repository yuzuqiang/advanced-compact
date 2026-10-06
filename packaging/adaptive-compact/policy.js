/**
 * Pressure policy: when to compact, how often, and when to stop.
 *
 * Pure functions over numbers — the decisions that matter most are the ones
 * easiest to get wrong and hardest to observe in production, so they are kept
 * out of the engine and unit-tested directly.
 *
 * @module adaptive-compact/policy
 */
/**
 * Whether pressure warrants compaction.
 *
 * Two different questions share this function, which is the point of the
 * hysteresis band:
 *
 * - Starting a pass (`inProgress` false) asks "are we above the threshold".
 * - Continuing one (`inProgress` true) asks "are we still above the release".
 *
 * Using one number for both is what makes a session compact, land just under
 * the threshold, and compact again on the next step.
 *
 * @param totalTokens - current measured pressure.
 * @param spec - the routed model's budgets.
 * @param options - `inProgress` when a pass has already compacted at least once.
 */
export function shouldCompact(totalTokens, spec, options = {}) {
    return options.inProgress === true
        ? totalTokens >= spec.releaseTokens
        : totalTokens >= spec.thresholdTokens;
}
/**
 * How many further passes this step may spend.
 * @param state - the step's current pass count, or undefined for a fresh step.
 * @param spec - the routed model's budgets.
 */
export function passBudget(state, spec) {
    return Math.max(0, spec.maxPassesPerStep - (state?.passes ?? 0));
}
/**
 * Whether enough has happened since the last compaction.
 *
 * Both clocks must agree, and neither is `surface.replaceGeneration`. That
 * counter advances only on positional replacements; ordinary user, assistant
 * and tool appends leave it untouched. A cooldown keyed on it would therefore
 * never elapse after the first compaction, pressure would climb unchecked, and
 * the system would degrade into relying on provider overflow recovery.
 *
 * @param mark - state at the last successful compaction, or undefined if never.
 * @param now - current state.
 * @param spec - the routed model's cooldown budgets.
 */
export function cooldownPassed(mark, now, spec) {
    if (mark === undefined)
        return true;
    return now.logRevision - mark.logRevision >= spec.cooldownLogEvents
        && now.turn - mark.turn >= spec.cooldownTurns;
}
/**
 * Capture the cooldown clocks for a session.
 * @param session - the live session.
 * @param measurement - a measurement already taken for this session.
 * @param turn - the current turn number, when one is open.
 */
export function markOf(session, measurement, turn) {
    return { logRevision: measurement.logRevision, turn: turn ?? currentTurn(session) };
}
/**
 * Read a log event through indexed eventAt when available, otherwise through
 * the legacy events array.
 * @param session - the session whose log is read.
 * @param seq - the event sequence number.
 * @returns the event, or undefined past the log tail.
 */
export function sessionEventAt(session, seq) {
    const indexed = session;
    return typeof indexed.eventAt === 'function' ? indexed.eventAt(seq) : session.events[seq];
}
/** The most recent turn number in the log, or 0 before any turn opened. */
export function currentTurn(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = sessionEventAt(session, seq);
        if (event.type === 'turn/start')
            return event.data.turn;
    }
    return 0;
}
/**
 * The most recent step number in the log, or 0 before any step opened.
 *
 * The pass budget is per STEP, so it must be keyed on one. Keying it on the
 * turn instead silently makes the budget per-turn: a long turn spanning many
 * model calls would spend its whole allowance on the first step and then never
 * compact again, however far pressure climbed.
 */
export function currentStep(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = sessionEventAt(session, seq);
        if (event.type === 'step/start')
            return event.data.step;
    }
    return 0;
}
/** Whether a session currently has an open turn — required by the automatic path. */
export function hasOpenTurn(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const type = sessionEventAt(session, seq).type;
        if (type === 'turn/start')
            return true;
        if (type === 'turn/end')
            return false;
    }
    return false;
}
