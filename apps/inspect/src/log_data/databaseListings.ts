import type {
  Condition,
  OrderByModel,
  Pagination,
} from "@tsmono/inspect-common/query";
import { throttle } from "@tsmono/util";

import { queryClient } from "../state/queryClient";

import { bumpLogsListingEpoch } from "./logsListingEpoch";

export const databaseLogsListingKeyRoot = [
  "log_data",
  "dexie-listing",
  "logs",
] as const;

export const databaseLogsListingKey = (
  scopeKey: string | undefined,
  accessorsKey: string,
  filter?: Condition,
  orderBy?: OrderByModel[],
  pagination?: Pagination
) =>
  [
    ...databaseLogsListingKeyRoot,
    scopeKey ?? null,
    accessorsKey,
    filter ?? null,
    orderBy ?? null,
    pagination ?? null,
  ] as const;

/** The scope slot of a {@link databaseLogsListingKey} — for same-scope
 *  checks (placeholders) without hard-coding the key shape at call sites. */
export const listingKeyScope = (queryKey: readonly unknown[]): unknown =>
  queryKey[databaseLogsListingKeyRoot.length];

/**
 * Coalesce replication bursts into at most one refetch of observed Dexie
 * listings per second. A throttle, not a debounce: the flush loops can write
 * back-to-back for a whole sync, and a trailing-only debounce would postpone
 * the invalidation for the entire burst instead of updating incrementally.
 *
 * The interval must exceed a refetch cycle at target scale, not just coalesce
 * writes: `invalidateQueries` cancels and restarts an in-flight refetch, and
 * a 20k-row dir's cycle (snapshot rebuild + page re-reads + the overview
 * scan) runs ~0.5-1s — at the previous 100ms the cycle restarted forever, so
 * results rarely landed and the row query never went idle (starving
 * `fetchNextPage`, which no-ops while a fetch is in flight). Measured on a
 * 20k-file stress dir; revisit alongside the index-backed snapshot build.
 */
export const invalidateDatabaseLogsListings: () => void = throttle(
  () => {
    // Epoch first: the refetches this triggers must rebuild their snapshots,
    // not be served the pre-write ones (see logsListingEpoch).
    bumpLogsListingEpoch();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    queryClient.invalidateQueries({
      queryKey: databaseLogsListingKeyRoot,
    });
  },
  1000,
  { leading: false }
);
