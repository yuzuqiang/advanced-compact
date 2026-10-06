// The public, dependency-free unit suite models only these two DSH seams.
// Real DSH/native transaction checks are separate; do not call this integration coverage.
import {registerHooks} from 'node:module';
const modules = {
  '@deepseek-ai/dsh-compaction/checkpoint': 'export const isCompactCheckpointSource = source => source.kind === "compact-checkpoint";',
  '@deepseek-ai/dsh-compaction': 'export const toolPairingBalancedBefore = (session, seq) => session.testBalancedCuts?.has(seq) ?? true;',
};
registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(modules, specifier)) return {url: 'performance-seam:' + specifier, shortCircuit: true};
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('performance-seam:')) return {format:'module',source:modules[url.slice('performance-seam:'.length)],shortCircuit:true};
    return next(url, context);
  },
});
