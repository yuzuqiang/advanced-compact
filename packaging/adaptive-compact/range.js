/**
 * Head-anchored range selection with checkpoint absorption.
 *
 * Head-anchored on purpose: replacing the oldest span invalidates the provider's
 * prefix cache from the first replaced token and leaves everything before it —
 * at most the system prompt — warm. Compacting a middle span would invalidate
 * more for the same reduction.
 *
 * @module @adaptive-compact/dsh-compaction-adaptive/range
 */
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { sessionEventAt } from "./policy.js";
/** Whether a surface node is a compaction checkpoint. */
export function isCheckpointNode(session, seq) {
    const event = sessionEventAt(session, seq);
    // Recognised by its source MARKER, never by looking for `<compacted-summary>`
    // in the text: a user message that merely mentions the tag would fool a text
    // match, and every backend's checkpoint carries the same marker.
    return event?.type === 'user/message' && isCompactCheckpointSource(event.data.source);
}
/**
 * Choose the span to compact.
 *
 * @param session - the live session, for tool-pairing checks.
 * @param measurement - a measurement of this exact surface.
 * @param spec - the routed model's budgets.
 * @returns the inclusive positional range, or `null` when nothing is worth compacting.
 * @throws when the measurement does not describe the current surface.
 */
export function selectAdaptiveRange(session, measurement, spec) {
    const priced = measurement.nodes;
    if (priced.length === 0)
        return null;
    const nodes = session.surface.nodes;
    if (nodes.length !== priced.length || nodes.some((seq, index) => seq !== priced[index]?.seq)) {
        // Selecting from a stale measurement would shadow the wrong nodes.
        throw new Error('compaction: token-meter surface does not match the current session surface');
    }
    // DSH 0.1.5 keeps the system prompt as a `system/message` at surface node 0
    // and rejects any replacement covering it ("surface replace: node 0 holds the
    // system prompt"), so the range starts after it. 0.1.2 had no system node,
    // which is also why its event-type union cannot name it here.
    const headType = sessionEventAt(session, nodes[0])?.type;
    const firstIdx = headType === 'system/message' ? 1 : 0;
    // 1. Walk back from the tail until the retain budget is met.
    let accumulated = 0;
    let keepFromIdx = priced.length;
    for (let index = priced.length - 1; index >= 0; index -= 1) {
        accumulated += priced[index].tokens;
        keepFromIdx = index;
        if (accumulated >= spec.retainTokens)
            break;
    }
    if (keepFromIdx <= firstIdx)
        return null;
    // 2. Absorb a checkpoint stalled at the head of the retained tail.
    //
    //    The node to test is surface[keepFromIdx] — the FIRST RETAINED node.
    //    surface[keepFromIdx - 1] is already inside the range, so testing it
    //    achieves nothing, and decrementing would push it OUT of the range, the
    //    opposite of the intent. A checkpoint parked here is retained on every
    //    pass, so old <compacted-summary> blocks pile up on the surface.
    //
    //    Absorbing moves the cut LATER, so the retained tail gets SMALLER — the
    //    cost is recent context, not extra context. `checkpointAbsorbFloor` bounds
    //    how far the tail may fall below its budget to pay for it.
    const absorbFloor = spec.retainTokens * spec.checkpointAbsorbFloor;
    // A lone checkpoint keeps the ordinary forward sum. Only a second one
    // justifies validating a reusable total; all later safe subtractions are
    // exact. Never reuse fractional/negative/unsafe prices or an unsafe total:
    // floating-point reassociation could otherwise move the absorption cut.
    let absorbedCheckpoints = 0;
    let reusableTail;
    while (keepFromIdx < priced.length && isCheckpointNode(session, nodes[keepFromIdx])) {
        let retainedAfterAbsorbing;
        if (absorbedCheckpoints === 1) {
            const tail = reusableTailTokens(priced, keepFromIdx + 1);
            retainedAfterAbsorbing = tail.total;
            reusableTail = tail.safe ? tail.total : undefined;
        }
        else if (reusableTail !== undefined) {
            retainedAfterAbsorbing = reusableTail - priced[keepFromIdx].tokens;
            reusableTail = retainedAfterAbsorbing;
        }
        else {
            retainedAfterAbsorbing = tailTokens(priced, keepFromIdx + 1);
        }
        if (retainedAfterAbsorbing < absorbFloor)
            break;
        accumulated = retainedAfterAbsorbing;
        keepFromIdx += 1;
        absorbedCheckpoints += 1;
    }
    if (keepFromIdx >= priced.length)
        return null;
    // 3. Retreat to a tool-pairing balanced cut.
    while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, nodes[keepFromIdx])) {
        keepFromIdx -= 1;
    }
    if (keepFromIdx <= firstIdx)
        return null;
    // 4. Minimum yield: a summarization call is not free.
    const tokens = priced.slice(firstIdx, keepFromIdx).reduce((total, node) => total + node.tokens, 0);
    if (tokens < spec.minCompactTokens)
        return null;
    return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1], tokens };
}
function tailTokens(priced, fromIdx) {
    let total = 0;
    for (let index = fromIdx; index < priced.length; index += 1)
        total += priced[index].tokens;
    return total;
}
// Keep the original forward addition order even when reuse is ineligible.
function reusableTailTokens(priced, fromIdx) {
    let total = 0;
    let safe = true;
    for (let index = fromIdx; index < priced.length; index += 1) {
        const tokens = priced[index].tokens;
        total += tokens;
        safe = safe && Number.isSafeInteger(tokens) && tokens >= 0;
    }
    return { total, safe: safe && Number.isSafeInteger(total) };
}
//# sourceMappingURL=range.js.map