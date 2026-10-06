/**
 * Line-window chunking for the retrieval index.
 *
 * Deterministic and pure: the same artifact and settings always produce the
 * same chunk ids, so an index rebuild does not invalidate stored references.
 *
 * @module @adaptive-compact/dsh-artifact-store/chunk
 */
import { createHash } from 'node:crypto';
import { splitLines } from "./blob.js";
/**
 * Split text into overlapping line windows.
 * @param uri - the artifact these chunks belong to.
 * @param text - full UTF-8 content.
 * @param opts - window size and overlap, in lines.
 * @returns chunks in document order.
 */
export function chunkText(uri, text, opts) {
    const lines = splitLines(text);
    if (lines.length === 0)
        return [];
    const step = opts.chunkLines - opts.chunkOverlapLines;
    /* v8 ignore next -- config validation guarantees a positive step. */
    if (step <= 0)
        throw new Error('chunkText: chunkOverlapLines must be below chunkLines');
    const chunks = [];
    for (let start = 0; start < lines.length; start += step) {
        const end = Math.min(start + opts.chunkLines, lines.length);
        const body = lines.slice(start, end).join('\n');
        chunks.push({
            uri,
            chunkId: `${start + 1}-${end}`,
            text: body,
            lineStart: start + 1,
            lineEnd: end,
            sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        });
        if (end === lines.length)
            break;
    }
    return chunks;
}
