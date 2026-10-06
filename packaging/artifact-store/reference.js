/**
 * Reference storage: who may read a blob, why it exists, and how long it stays.
 *
 * Authorization is "does this principal hold a reference to this digest",
 * which keeps content addressing intact while making tenancy enforceable. A
 * digest is unguessable (256 bits), but unguessable is not the same as
 * authorized: a digest that leaks through a summary or a log must still be
 * unreadable by a tenant that never produced it.
 *
 * @module @adaptive-compact/dsh-artifact-store/reference
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SECURITY_LABEL_ORDER } from "./types.js";
/** Whether `label` is at or below what `principal` may read. */
export function labelAllowed(label, principal) {
    return SECURITY_LABEL_ORDER.indexOf(label) <= SECURITY_LABEL_ORDER.indexOf(principal.maxLabel);
}
/** The most restrictive of a set of labels. */
export function highestLabel(labels) {
    return labels.reduce((worst, label) => SECURITY_LABEL_ORDER.indexOf(label) > SECURITY_LABEL_ORDER.indexOf(worst) ? label : worst, 'public');
}
/** A tenant id is a path component, so it must not be able to escape one. */
function safeSegment(value, what) {
    if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error(`artifact reference: ${what} must be 1-128 chars of [A-Za-z0-9._-], got ${JSON.stringify(value)}`);
    }
    return value;
}
export class ReferenceStore {
    root;
    /** digest → references, loaded lazily and kept in sync with the log. */
    cache = new Map();
    /** Directories already created, so the synchronous write path skips the syscall. */
    ensured = new Set();
    constructor(root) {
        this.root = root;
    }
    /** mkdir once per directory: `add()` is on the synchronous prune path. */
    ensureDir(dir) {
        if (this.ensured.has(dir))
            return;
        mkdirSync(dir, { recursive: true });
        this.ensured.add(dir);
    }
    indexPath(digest) {
        return join(this.root, 'refs', 'index', `${digest}.jsonl`);
    }
    sessionPath(tenantId, sessionId) {
        return join(this.root, 'refs', safeSegment(tenantId, 'tenantId'), `${safeSegment(sessionId, 'sessionId')}.jsonl`);
    }
    /** All references for a digest, regardless of tenant. */
    all(digest) {
        const cached = this.cache.get(digest);
        if (cached !== undefined)
            return cached;
        const refs = [];
        try {
            for (const line of readFileSync(this.indexPath(digest), 'utf8').split('\n')) {
                if (line.length > 0)
                    refs.push(JSON.parse(line));
            }
        }
        catch {
            // No index file means no references, which is a normal state.
        }
        this.cache.set(digest, refs);
        return refs;
    }
    /** References visible to a principal: same tenant, and within its label ceiling. */
    visible(digest, principal, now = Date.now()) {
        return this.all(digest).filter(ref => ref.tenantId === principal.tenantId
            && ref.retainUntil > now
            && labelAllowed(ref.securityLabel, principal));
    }
    add(reference) {
        const full = { refId: randomUUID(), ...reference };
        this.ensureDir(join(this.root, 'refs', 'index'));
        appendFileSync(this.indexPath(full.sha256), `${JSON.stringify(full)}\n`);
        const sessionFile = this.sessionPath(full.tenantId, full.sessionId);
        this.ensureDir(join(sessionFile, '..'));
        appendFileSync(sessionFile, `${JSON.stringify({ refId: full.refId, sha256: full.sha256, at: full.createdAt })}\n`);
        const cached = this.cache.get(full.sha256);
        if (cached !== undefined)
            cached.push(full);
        return full;
    }
    /**
     * Drop one reference. The blob survives until `sweep()` finds it unreferenced.
     * @returns whether a reference was removed.
     */
    remove(refId, digest) {
        const refs = [...this.all(digest)];
        const next = refs.filter(ref => ref.refId !== refId);
        if (next.length === refs.length)
            return false;
        this.cache.set(digest, next);
        if (next.length === 0)
            rmSync(this.indexPath(digest), { force: true });
        else
            writeFileSync(this.indexPath(digest), next.map(ref => `${JSON.stringify(ref)}\n`).join(''));
        return true;
    }
    /** Drop every expired reference and report the digests they pointed at. */
    expire(now) {
        let removed = 0;
        const touched = new Set();
        for (const digest of this.indexedDigests()) {
            const refs = [...this.all(digest)];
            const live = refs.filter(ref => ref.retainUntil > now);
            if (live.length === refs.length)
                continue;
            removed += refs.length - live.length;
            touched.add(digest);
            this.cache.set(digest, live);
            if (live.length === 0)
                rmSync(this.indexPath(digest), { force: true });
            else
                writeFileSync(this.indexPath(digest), live.map(ref => `${JSON.stringify(ref)}\n`).join(''));
        }
        return { removed, digests: touched };
    }
    indexedDigests() {
        const dir = join(this.root, 'refs', 'index');
        if (!existsSync(dir))
            return [];
        return readdirSync(dir)
            .filter(name => name.endsWith('.jsonl'))
            .map(name => name.slice(0, -6));
    }
    count(digest) {
        return this.all(digest).length;
    }
}
//# sourceMappingURL=reference.js.map