/** Master data changes rarely and every write invalidates its entry explicitly. */
export const BRANCH_CACHE_TTL_MS = 5 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 1_000;
