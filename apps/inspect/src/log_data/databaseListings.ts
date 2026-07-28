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
 * `cancelRefetch: false` because by default `invalidateQueries` cancels an
 * in-flight fetch and restarts it as a refetch of the loaded pages — which
 * demotes an in-flight `fetchNextPage` and discards its page. When a dir's
 * refetch cycle (snapshot rebuild + page re-reads) outlasts the throttle
 * interval — ~1.2s on a 50k-row stress dir — every next-page fetch got
 * demoted before it could land and pagination stalled for as long as the
 * ingestion sweep kept writing. Skipping instead means the in-flight fetch
 * completes and the query stays marked stale; the next trigger (during a
 * burst, at most one interval away) picks up the bumped epoch. The tail
 * case — a burst's LAST invalidation skipping because a fetch was in
 * flight — leaves loaded pages one epoch stale until the next write or
 * query-input change; accepted, the listing is asynchronous by design.
 */
export const invalidateDatabaseLogsListings: () => void = throttle(
  () => {
    // Epoch first: the refetches this triggers must rebuild their snapshots,
    // not be served the pre-write ones (see logsListingEpoch).
    bumpLogsListingEpoch();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    queryClient.invalidateQueries(
      { queryKey: databaseLogsListingKeyRoot },
      { cancelRefetch: false }
    );
  },
  1000,
  { leading: false }
);
