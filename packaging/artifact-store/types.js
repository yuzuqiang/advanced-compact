/**
 * Public vocabulary for the artifact store.
 *
 * The central decision recorded here is the blob/reference split. Content
 * addressing deduplicates by construction: the same `cargo test` output written
 * from two sessions — or two tenants — has one digest. Attaching ACL,
 * provenance, and retention to the DIGEST would mean the first writer decides
 * the security label for everyone, later writers leave no reference for GC to
 * see, and a single provenance record cannot describe multiple users of the
 * same bytes. So bytes and claims-about-bytes are separate stores.
 *
 * @module @adaptive-compact/dsh-artifact-store/types
 */
export const SECURITY_LABEL_ORDER = ['public', 'internal', 'confidential', 'secret'];
