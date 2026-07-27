import { useAsyncDataFromQuery } from "@tsmono/react/hooks";
import { AsyncData } from "@tsmono/util";

import {
  databaseLogsListingKeyRoot,
  type LogsListingData,
  type LogsOverview,
  type LogsOverviewView,
} from "../../log_data";

interface UseLogsOverviewParams<TRow> {
  logDir: string;
  /** Cache identity of the view (see `useDatabaseLogsListingQuery`'s
   *  `universe`) — everything `view` reads beyond the records. `undefined`
   *  while the scope is hydrating (disables the query). */
  universe: string | undefined;
  /** The panel's listing data access (shared with the row/match queries). */
  data: LogsListingData<TRow>;
  view: LogsOverviewView;
}

/**
 * The page-level aggregates beside the row query (see the listing data's
 * `getOverview`). Keyed under the listing root so the write path's
 * throttled invalidation refreshes it alongside the row queries.
 */
export const useLogsOverview = <TRow>({
  logDir,
  universe,
  data,
  view,
}: UseLogsOverviewParams<TRow>): AsyncData<LogsOverview> => {
  return useAsyncDataFromQuery({
    queryKey: [...databaseLogsListingKeyRoot, "overview", logDir, universe],
    queryFn: () => data.getOverview(view),
    enabled: universe !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};
