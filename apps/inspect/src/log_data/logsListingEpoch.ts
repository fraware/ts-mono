/**
 * Invalidation epoch for the logs-listing data layer's internal caches.
 *
 * The write path bumps the epoch (from `invalidateDatabaseLogsListings`,
 * inside the same throttled flush that invalidates the react-query listing
 * keys — a mid-burst bump would rebuild snapshots that in-flight page reads
 * still need to share); every cached snapshot records the epoch it was
 * built under and rebuilds when it no longer matches. The required ordering
 * — a refetch must never be served the pre-write snapshot — holds by
 * construction rather than by call-site discipline, and per-view data
 * instances need no registration with the write path.
 */

let epoch = 0;

export const logsListingEpoch = (): number => epoch;

export const bumpLogsListingEpoch = (): void => {
  epoch += 1;
};
