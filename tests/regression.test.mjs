import './no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveAdaptiveConfig, resolveSpec} from '../plugin/config.js';
import {shouldCompact} from '../plugin/policy.js';
import {groundFileArtifacts, parseSummaryDocument, renderSummary} from '../plugin/summary.js';
import {AdaptiveCompactionEngine} from '../plugin/index.js';
const headlessRoot = new URL('./fixtures/headless',import.meta.url).pathname;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const anchors = {all: [], overflow: []};
const base = {profile: 'custom', thresholdRatio: .8, retainTokens: 8192, hysteresis: {releaseRatio: .2}};
const fixture=read(new URL('./fixtures/source-quote.json',import.meta.url));
const pilotDoc=parseSummaryDocument(fixture.rawBlocks.filter(b=>b.type==='text').map(b=>b.text).join(''),1);
const source=fixture.source;

test('adapter input ceiling triggers before configured model-window threshold', () => {
    const previous = resolveSpec(resolveAdaptiveConfig(base), 131072, 16384, 16384);
    const fixed = resolveSpec(resolveAdaptiveConfig({...base, budget: {maxInputTokens: 45056}}), 131072, 16384, 16384);
    assert.equal(shouldCompact(50000, previous), false);
    assert.equal(shouldCompact(50000, fixed), true);
    assert.equal(fixed.usableInputTokens, 45056);
    assert(fixed.releaseTokens < fixed.thresholdTokens);
    assert.equal(fixed.retainTokens, previous.retainTokens);
});
test('input-only cap does not subtract the output reservation twice', () => {
    const spec = resolveSpec(resolveAdaptiveConfig({...base, budget: {maxInputTokens: 49152}}), 131072, 16384, 16384);
    assert.equal(spec.usableInputTokens, 49152);
});
test('small model output reserve still controls admission', () => {
    const config = {profile: 'custom', retainTokens: 1024, budget: {maxInputTokens: 65536, outputReserve: 2048}};
    assert.equal(resolveSpec(resolveAdaptiveConfig(config), 8192, 2048, 2048).usableInputTokens, 6144);
});
test('unconfigured and zero cap produce identical budgets across model windows', () => {
    let comparisons = 0;
    for (const context of [12288, 32768, 131072]) for (const ratio of [.25, .5, .8]) for (const output of [768, 1024]) {
        const config = {profile:'custom', thresholdRatio:ratio, retainTokens:1024, hysteresis:{releaseRatio:.2}};
        const expected = resolveSpec(resolveAdaptiveConfig(config), context, output, output);
        assert.deepEqual(resolveSpec(resolveAdaptiveConfig({...config,budget:{maxInputTokens:0}}), context, output, output), expected);
        comparisons += 1;
    }
    assert.equal(comparisons, 18);
});
test('configuration rejects invalid input caps and non-boolean artifact guard', () => {
    for (const value of [-1, .5, Infinity, '49152']) assert.throws(() => resolveAdaptiveConfig({budget:{maxInputTokens:value}}));
    assert.throws(() => resolveAdaptiveConfig({summary:{verbatimFileArtifacts:'true'}}));
    assert.throws(() => resolveSpec(resolveAdaptiveConfig({...base,budget:{maxInputTokens:8192}}),131072,16384,16384), /retainTokens/);
});
test('original source description corruption reproduces and is omitted', () => {
    assert(source.includes('current = current[token]'));
    assert(pilotDoc.files[0].artifact.includes('current[current[token]]'));
    const original = renderSummary(pilotDoc, anchors, 1);
    assert(original.includes('current[current[token]]'));
    const fixed = groundFileArtifacts(pilotDoc, [source]);
    assert(!renderSummary(fixed, anchors, 1).includes('current[current[token]]'));
    assert.deepEqual(fixed.files.map(file => file.path), pilotDoc.files.map(file => file.path));
    assert.deepEqual(fixed.task_state, pilotDoc.task_state);
    assert.deepEqual(fixed.user_constraints, pilotDoc.user_constraints);
    assert(pilotDoc.files[0].artifact.includes('current[current[token]]'), 'raw evidence must survive');
});
test('exact source quote survives byte-for-byte; paraphrase and Unicode normalization do not', () => {
    const doc = {...pilotDoc,files:[
        {path:'a.py',operation:'read',artifact:'current = current[token]'},
        {path:'b.py',operation:'read',artifact:'café'},
        {path:'c.py',operation:'read',artifact:'cafe\u0301'},
        {path:'d.py',operation:'modify_planned'},
    ]};
    const fixed = groundFileArtifacts(doc, [source, 'café']);
    assert.equal(fixed.files[0].artifact, doc.files[0].artifact);
    assert.equal(fixed.files[1].artifact, 'café');
    assert.equal(fixed.files[2].artifact, undefined);
    assert.deepEqual(fixed.files[3], doc.files[3]);
});

// Exercise the actual plugin's parse/admit/render branch, with an in-memory
// summary transport and owned service stubs. No native transaction or model.
async function replay(config, doc, messages) {
    const engine = Object.create(AdaptiveCompactionEngine.prototype);
    engine.adaptive = config;
    engine.stats = {parseFailures:0,shapeRepairs:0};
    engine.ctx = {logger:{warn(){}}};
    engine.isSecretTainted = () => false;
    engine.secretDowngradeReason = () => undefined;
    engine.buildAnchors = () => anchors;
    engine.streamSummary = async () => ({text:JSON.stringify(doc),blocks:[{type:'text',text:JSON.stringify(doc)}],provider:'mock',model:'saved-summary'});
    engine.redactMessages = messages => messages;
    engine.spillOverflow = () => undefined;
    engine.artifactResolver = () => undefined;
    engine.redact = text => text;
    engine.withSecretProvenance = blocks => blocks;
    engine.result = (raw, summary) => ({summary,rawOutput:raw.blocks});
    return engine.summarizeUnchecked({messages},{session:{}},new AbortController().signal);
}
test('guard disabled preserves original checkpoint rendering', async () => {
    const b = await replay(resolveAdaptiveConfig({}),pilotDoc,[]);
    assert.deepEqual(b.summary,[{type:'text',text:renderSummary(pilotDoc,anchors,1)}]);
});
test('guard integrates with split tool text and never trusts assistant claims', async () => {
    const doc = {...pilotDoc,files:[{path:'a.py',operation:'read',artifact:'current = current[token]'},pilotDoc.files[0]]};
    const messages = [{role:'tool',content:[{type:'text',text:'current = current['},{type:'text',text:'token]'}]},
        {role:'assistant',content:[{type:'text',text:pilotDoc.files[0].artifact}]}];
    const result = await replay(resolveAdaptiveConfig({summary:{verbatimFileArtifacts:true}}),doc,messages);
    assert(result.summary[0].text.includes('current = current[token]'));
    assert(!result.summary[0].text.includes('current[current[token]]'));
    assert(result.rawOutput[0].text.includes('current[current[token]]'));
});
test('checkpoint with only unsupported artifact does not bypass empty-summary gate', async () => {
    const doc = {schema_version:1,task_state:{goal:'',current_plan:[],completed:[],open:[]},files:[{path:'',operation:'',artifact:'invented'}],decisions:[],tests:[],errors:[],critical_facts:[],user_constraints:[],next_step:'',artifact_refs:[]};
    await assert.rejects(replay(resolveAdaptiveConfig({summary:{verbatimFileArtifacts:true}}),doc,[]),{code:'COMPACTION_EMPTY_SUMMARY'});
});
for (const scenario of ['pinned-state','latest-correction','longer-pressure']) {
    test(`saved headless summary replay preserves six values: ${scenario}`, async () => {
        const job = `${headlessRoot}/jobs/${scenario}-compact`;
        const native = read(`${job}/native-result.json`), config = read(`${job}/job.json`);
        const raw = native.events.find(event=>event.type==='compaction/summary').data.rawOutput;
        const doc = parseSummaryDocument(raw.filter(block=>block.type==='text').map(block=>block.text).join(''),1);
        const a = await replay(resolveAdaptiveConfig({}),doc,[]);
        const b = await replay(resolveAdaptiveConfig({summary:{verbatimFileArtifacts:true}}),doc,[]);
        for (const value of Object.values(config.expected)) {
            assert(a.summary[0].text.includes(value));
            assert(b.summary[0].text.includes(value));
        }
        const previous = resolveSpec(resolveAdaptiveConfig({profile:'custom',thresholdRatio:.25,retainTokens:8192,hysteresis:{releaseRatio:.2}}),131072,16384,16384);
        const fixed = resolveSpec(resolveAdaptiveConfig({profile:'custom',thresholdRatio:.25,retainTokens:8192,hysteresis:{releaseRatio:.2},budget:{maxInputTokens:45056}}),131072,16384,16384);
        assert.deepEqual(fixed.thresholdTokens,previous.thresholdTokens);
        assert.deepEqual(fixed.releaseTokens,previous.releaseTokens);
    });
}
