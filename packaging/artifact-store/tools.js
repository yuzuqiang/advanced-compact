/**
 * `artifact_read` and `artifact_grep` — how a model gets the middle back.
 *
 * Offloading is only lossless if the agent can retrieve what was moved. These
 * two tools are the retrieval half; the omission marker on the surface names
 * them explicitly so the model knows the content is still reachable.
 *
 * Registered through `ctx.tools` only when a registry exists, so a headless
 * composition can use the store without one.
 *
 * @module @adaptive-compact/dsh-artifact-store/tools
 */
import { ArtifactError } from "./errors.js";
import { isArtifactUri } from "./uri.js";
function requireUri(args) {
    const uri = args.uri;
    if (!isArtifactUri(uri)) {
        // Refuse anything that is not the exact canonical form: this is the
        // path-traversal and SSRF boundary, and a model is an untrusted source of
        // URIs. Reporting the shape rather than the value avoids echoing an
        // attacker-chosen string back into the transcript.
        throw new ArtifactError('ARTIFACT_INVALID_URI', `expected artifact://sha256/<64 lowercase hex>, got ${JSON.stringify(String(uri).slice(0, 80))}`);
    }
    return uri;
}
/**
 * Render one `artifact_read` value for the model.
 *
 * The registry validates the canonical value against `output.schema` and then
 * calls this to produce what the model actually sees. Keeping the line range in
 * the rendered text matters: the model needs to know *where* it landed to ask
 * for the next window.
 */
function renderRead(value) {
    const v = value;
    const header = `artifact lines ${v.lineStart}-${v.lineEnd}${v.truncated ? ' (truncated)' : ''}`;
    return [{ type: 'text', text: `${header}\n${v.text}` }];
}
/** Render one `artifact_grep` value: line-numbered hits, or an explicit no-match. */
function renderGrep(value) {
    const v = value;
    if (v.hits.length === 0)
        return [{ type: 'text', text: 'no matches' }];
    const body = v.hits.map(hit => `${hit.lineStart}: ${hit.text}`).join('\n');
    const suffix = v.truncated ? '\n(hit limit reached; narrow the pattern)' : '';
    return [{ type: 'text', text: `${v.totalHits} match(es)\n${body}${suffix}` }];
}
/**
 * Register the artifact tools.
 * @param ctx - a context whose `ctx.tools` registry exists.
 * @param store - the artifact store the tools read from.
 * @param resolvePrincipal - how to derive the caller's identity.
 * @returns a disposer that unregisters both tools.
 */
export function registerArtifactTools(ctx, store, resolvePrincipal = () => store.principalFor()) {
    const maxBytes = store.config.maxToolReadBytes;
    const disposeRead = ctx.tools.register({
        name: 'artifact_read',
        description: 'Read the exact original content of an offloaded tool result. Use this when a '
            + 'tool result shows an omission marker and you need the part that was omitted.',
        parameters: {
            type: 'object',
            required: ['uri'],
            properties: {
                uri: { type: 'string', description: 'artifact://sha256/<digest> from the tool result header' },
                unit: { type: 'string', enum: ['line', 'byte'], default: 'line' },
                start: { type: 'integer', description: 'inclusive start (1-based for lines)' },
                end: { type: 'integer', description: 'inclusive end line, or exclusive end byte' },
                maxBytes: { type: 'integer', description: `ceiling on returned bytes (max ${maxBytes})` },
            },
        },
        output: {
            schema: {
                type: 'object',
                required: ['text', 'lineStart', 'lineEnd', 'truncated', 'byteLength'],
                properties: {
                    text: { type: 'string', description: 'the requested slice, verbatim' },
                    lineStart: { type: 'integer' },
                    lineEnd: { type: 'integer' },
                    truncated: { type: 'boolean', description: 'true when the ceiling cut the slice short' },
                    byteLength: { type: 'integer' },
                },
            },
            render: (_args, value) => renderRead(value),
        },
        async execute(raw) {
            const args = (raw ?? {});
            const uri = requireUri(args);
            const unit = args.unit === 'byte' ? 'byte' : 'line';
            const start = typeof args.start === 'number' ? args.start : 1;
            const end = typeof args.end === 'number' ? args.end : Number.MAX_SAFE_INTEGER;
            // A model asking for more than the ceiling still gets the ceiling:
            // reading an artifact wholesale back into context would undo the offload.
            const ceiling = Math.min(typeof args.maxBytes === 'number' ? args.maxBytes : maxBytes, maxBytes);
            const slice = store.readText(uri, { unit, start, end }, resolvePrincipal(args), ceiling);
            return {
                text: slice.text,
                lineStart: slice.lineStart,
                lineEnd: slice.lineEnd,
                truncated: slice.truncated,
                byteLength: Buffer.byteLength(slice.text, 'utf8'),
            };
        },
    });
    const disposeGrep = ctx.tools.register({
        name: 'artifact_grep',
        description: 'Search inside an offloaded artifact and return matching lines with line numbers. '
            + 'Prefer this over artifact_read when you are looking for something specific, such '
            + 'as an error in a long build log.',
        parameters: {
            type: 'object',
            required: ['uri', 'pattern'],
            properties: {
                uri: { type: 'string' },
                pattern: { type: 'string' },
                regex: { type: 'boolean', default: false },
                maxHits: { type: 'integer', default: 50 },
                contextLines: { type: 'integer', default: 2 },
            },
        },
        output: {
            schema: {
                type: 'object',
                required: ['hits', 'totalHits', 'truncated'],
                properties: {
                    hits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['lineStart', 'lineEnd', 'text'],
                            properties: {
                                lineStart: { type: 'integer' },
                                lineEnd: { type: 'integer' },
                                text: { type: 'string' },
                            },
                        },
                    },
                    totalHits: { type: 'integer' },
                    truncated: { type: 'boolean' },
                },
            },
            render: (_args, value) => renderGrep(value),
        },
        async execute(raw) {
            const args = (raw ?? {});
            const uri = requireUri(args);
            const pattern = typeof args.pattern === 'string' ? args.pattern : '';
            const hits = store.grep(uri, pattern, {
                regex: args.regex === true,
                maxHits: typeof args.maxHits === 'number' ? Math.min(args.maxHits, 200) : 50,
                contextLines: typeof args.contextLines === 'number' ? Math.min(args.contextLines, 20) : 2,
            }, resolvePrincipal(args));
            return {
                hits: hits.map(hit => ({ lineStart: hit.lineStart, lineEnd: hit.lineEnd, text: hit.text })),
                totalHits: hits.length,
                truncated: hits.length >= 200,
            };
        },
    });
    const dispose = () => {
        disposeRead();
        disposeGrep();
    };
    // `effect` takes a SETUP body and treats its return value as the disposer.
    // Passing `dispose` directly ran it immediately and unregistered both tools
    // the instant they were registered — silently, because unregistering is not
    // an error. The fake registry in the unit tests recorded the `register` calls
    // and never modelled the disposal, so every assertion still passed.
    ctx.effect(() => dispose);
    return dispose;
}
//# sourceMappingURL=tools.js.map