/**
 * Map domain messages to the REST sidecar protocol and back.
 * Wire text, artifact_ref, code and image_ref blocks differ from domain blocks.
 * @module adaptive-compact/sidecar-serialize
 */
import { scrubUnresolvableUris } from "./summary.js";
/**
 * Map a user-role message with tool provenance to wire role tool.
 * The sidecar must distinguish untrusted tool output from human instructions.
 */
export function toSurfaceNode(node) {
    const { seq, message } = node;
    const role = message.role === 'user' && message.source.kind === 'tool' ? 'tool' : message.role;
    const toolCallId = firstToolCallId(message.content);
    return {
        seq,
        role,
        content: toWireContentBlocks(message.content),
        ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    };
}
function firstToolCallId(blocks) {
    for (const block of blocks) {
        if (block.type === 'tool-result')
            return String(block.toolCallId);
    }
    return undefined;
}
/**
 * Domain content blocks to wire form. `text`/`reasoning` become wire
 * `text`; `tool-call`/`tool-result` become wire `text` carrying a
 * formatted rendering (the same flattening `coalescedBlockText()` already
 * applies for the SEC-06 secret scan, one module over). Images are
 * dropped: no lossless wire representation exists without deeper
 * attachment-service integration — explicitly out of scope here, not an
 * oversight.
 */
export function toWireContentBlocks(blocks) {
    const out = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
            case 'reasoning':
                if (block.text.length > 0)
                    out.push({ type: 'text', text: block.text });
                break;
            case 'tool-call':
                // block.id included in the rendering (Codex review, PR #18 round
                // 5): this repo's own ToolCallBlock carries an id specifically to
                // "correlate with the matching tool result" (its own doc comment,
                // @deepseek-ai/dsh-llm), and an assistant message may contain
                // MULTIPLE tool-call blocks (parallel calls) — toSurfaceNode()'s
                // own WireSurfaceNode.tool_call_id only ever captures the FIRST
                // tool-RESULT id per node, and never applies to a tool-CALL node
                // at all. Without the id embedded here, a sidecar (or a human
                // reading raw wire data) receiving later tool-result nodes has no
                // way to attribute which result answers which call once there is
                // more than one in flight.
                out.push({ type: 'text', text: `[tool call ${block.id}: ${block.name}] ${block.arguments}` });
                break;
            case 'tool-result':
                out.push({
                    type: 'text',
                    // toolCallId included for the same reason and the same
                    // symmetry — the node-level tool_call_id already carries the
                    // FIRST such id, but embedding it here too keeps a single
                    // rendered block self-describing on its own, without relying on
                    // which node it happened to land in.
                    text: `[tool result ${block.toolCallId}${block.isError === true ? ' (error)' : ''}] `
                        + wireText(block.content),
                });
                break;
            case 'image':
                break; // dropped — see module doc.
        }
    }
    return out;
}
// Nested tool results need text only, not temporary wire-block objects.
function wireText(blocks) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
            case 'reasoning':
                if (block.text.length > 0) parts.push(block.text);
                break;
            case 'tool-call':
                parts.push(`[tool call ${block.id}: ${block.name}] ${block.arguments}`);
                break;
            case 'tool-result':
                parts.push(`[tool result ${block.toolCallId}${block.isError === true ? ' (error)' : ''}] ` + wireText(block.content));
                break;
        }
    }
    return parts.join('\n');
}
/**
 * Wire content blocks back to domain form, for a sidecar's returned
 * `summary`.
 *
 * Wire `text`/`code` become a domain `TextBlock`. Wire `artifact_ref`/
 * `image_ref` become a `TextBlock` whose text is the literal
 * `artifact://sha256/<digest>` URI — this package's own established
 * convention for citing an artifact inline (the same shape `anchors.js`'s
 * `ARTIFACT_URI` regex and `buildAnchors()`'s own `resolveArtifact`
 * callback already scan for), rather than inventing a new block-level
 * artifact representation the rest of this codebase has no notion of. A
 * block with no `sha256` produces inert, non-matching text
 * (`artifact://sha256/`) rather than a thrown error — it can never satisfy
 * the 64-hex-digest URI shape `scrubUnresolvableUris()`'s own regex
 * requires, so it is harmless, unresolvable-looking text, not a
 * masquerading reference. Every reference — resolvable or not — is scrubbed
 * via `scrubUnresolvableUris()`, the same authentication every other path
 * already applies before a citation reaches a checkpoint.
 *
 * @param blocks - the sidecar's returned `summary`.
 * @param resolveArtifact - see `scrubUnresolvableUris()`.
 */
export function fromWireContentBlocks(blocks, resolveArtifact) {
    const out = [];
    for (const block of blocks) {
        if (block.type === 'text' || block.type === 'code') {
            out.push({ type: 'text', text: scrubUnresolvableUris(block.text ?? '', resolveArtifact) });
        }
        else if (block.type === 'artifact_ref' || block.type === 'image_ref') {
            const uri = `artifact://sha256/${block.sha256 ?? ''}`;
            out.push({ type: 'text', text: scrubUnresolvableUris(uri, resolveArtifact) });
        }
    }
    return out;
}
