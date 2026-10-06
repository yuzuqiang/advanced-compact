/**
 * Text slicing that does not corrupt what it returns.
 *
 * A byte-range read into UTF-8 content can land mid-codepoint. Decoding that
 * slice directly yields U+FFFD, which then travels into a model's context as if
 * it were the file's real content. So byte ranges are snapped outward to
 * codepoint boundaries and the caller is told what was actually read.
 *
 * @module @adaptive-compact/dsh-artifact-store/text
 */
/** A UTF-8 continuation byte is `10xxxxxx`. */
function isContinuation(byte) {
    return (byte & 0b1100_0000) === 0b1000_0000;
}
/**
 * Snap a byte range outward to UTF-8 codepoint boundaries.
 * @param buffer - the whole artifact.
 * @param start - requested inclusive start byte.
 * @param end - requested exclusive end byte.
 * @returns a range whose decode is lossless.
 */
export function alignUtf8(buffer, start, end) {
    let from = Math.max(0, Math.min(start, buffer.byteLength));
    let to = Math.max(from, Math.min(end, buffer.byteLength));
    // Walk back to the start of the codepoint the range begins inside.
    while (from > 0 && isContinuation(buffer[from]))
        from -= 1;
    // Walk forward past the tail of the codepoint the range ends inside.
    while (to < buffer.byteLength && isContinuation(buffer[to]))
        to += 1;
    return { start: from, end: to };
}
/**
 * Build a line index over UTF-8 bytes without materializing every line.
 *
 * `Buffer.indexOf` is a native scan; the equivalent per-byte JavaScript loop
 * costs several times as much on the multi-hundred-KB artifacts this exists for.
 */
export function indexLines(buffer) {
    const starts = [0];
    let from = buffer.indexOf(0x0a);
    while (from !== -1 && from + 1 < buffer.byteLength) {
        starts.push(from + 1);
        from = buffer.indexOf(0x0a, from + 1);
    }
    return { starts };
}
/**
 * Byte range covering an inclusive 1-based line range.
 * @param index - line index for the buffer.
 * @param buffer - the whole artifact.
 * @param startLine - inclusive, 1-based; values below 1 clamp to 1.
 * @param endLine - inclusive, 1-based; values past the end clamp to the last line.
 */
export function lineRangeToBytes(index, buffer, startLine, endLine) {
    const total = index.starts.length;
    if (total === 0)
        return { start: 0, end: 0, lineStart: 0, lineEnd: 0 };
    const from = Math.max(1, Math.min(startLine, total));
    const to = Math.max(from, Math.min(endLine, total));
    const start = index.starts[from - 1];
    const end = to >= total ? buffer.byteLength : index.starts[to];
    return { start, end, lineStart: from, lineEnd: to };
}
/** 1-based line number containing a byte offset. */
export function lineAt(index, offset) {
    let lo = 0;
    let hi = index.starts.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (index.starts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo + 1;
}
