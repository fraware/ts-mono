import {
  InfiniteData,
  skipToken,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";

import type {
  MessageRow,
  MessageRowsModel,
} from "@tsmono/inspect-components/chat";

import { SampleHandle } from "../app/types";

import {
  kMessageRowsPageSize,
  type InMemoryMessageRows,
  type MessageRowsPage,
  type SampleMessagesData,
} from "./messageRows";
import { kSampleGcTimeMs } from "./sampleQuery";

const isInMemory = (
  source: SampleMessagesData
): source is InMemoryMessageRows => "rowsSync" in source;

/** Pre-chunked cache seed for a fully-resident source: every page present,
 *  so the query never fetches and the list never shows a placeholder. */
const seedPages = (
  rows: MessageRow[]
): InfiniteData<MessageRowsPage, number> => {
  const total = rows.length;
  const pages: MessageRowsPage[] = [];
  const pageParams: number[] = [];
  for (let lo = 0; lo === 0 || lo < total; lo += kMessageRowsPageSize) {
    const hi = Math.min(lo + kMessageRowsPageSize, total);
    pages.push({
      rows: rows.slice(lo, hi),
      offset: lo,
      totalRowCount: total,
      nextCursor: hi < total ? { position: hi } : null,
      prevCursor: lo > 0 ? { position: lo } : null,
    });
    pageParams.push(lo);
  }
  return { pages, pageParams };
};

/**
 * The Messages tab's rows-model over a SampleMessagesData source: pages
 * held in a react-query infinite query (forward-contiguous from row 0),
 * exposed as the loaded-or-not random access the chat list core consumes.
 * `requestRange` beyond the loaded prefix advances the query one page at a
 * time; the core re-requests as each page lands, so a scrolled-to range is
 * reached by walking pages forward. In-memory sources seed every page up
 * front and never fetch.
 *
 * Undefined until the source exists and its first page is resident.
 */
export const useMessageRowsModel = (
  logDir: string,
  handle: SampleHandle | undefined,
  source: SampleMessagesData | undefined
): MessageRowsModel | undefined => {
  const query = useInfiniteQuery({
    queryKey: [
      "log_data",
      "message-rows",
      logDir,
      handle?.logFile ?? null,
      handle?.id ?? null,
      handle?.epoch ?? null,
    ],
    queryFn:
      source && handle
        ? ({ pageParam }) =>
            source.getRows({
              cursor: pageParam === 0 ? null : { position: pageParam },
              direction: "forward",
              limit: kMessageRowsPageSize,
            })
        : skipToken,
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor?.position,
    initialData:
      source && isInMemory(source)
        ? () => seedPages(source.rowsSync())
        : undefined,
    gcTime: kSampleGcTimeMs,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // MessageRows hold large resolved message graphs — never clone/merge.
    structuralSharing: false,
  });

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  return useMemo<MessageRowsModel | undefined>(() => {
    const pages = data?.pages;
    if (source === undefined || pages === undefined || pages.length === 0) {
      return undefined;
    }
    const total = pages[0]?.totalRowCount ?? 0;
    // Pages are forward-contiguous from 0, but place by offset anyway so a
    // malformed page can't silently shift every row after it.
    const loaded = new Array<MessageRow | undefined>(total);
    for (const page of pages) {
      for (let i = 0; i < page.rows.length; i++) {
        loaded[page.offset + i] = page.rows[i];
      }
    }
    return {
      total,
      rowAt: (index) => loaded[index],
      requestRange: (_start, end) => {
        if (end > loadedCount(pages) && hasNextPage && !isFetchingNextPage) {
          // failures surface through the query's own error state
          fetchNextPage().catch(() => undefined);
        }
      },
    };
  }, [source, data, hasNextPage, isFetchingNextPage, fetchNextPage]);
};

const loadedCount = (pages: MessageRowsPage[]): number => {
  const last = pages[pages.length - 1];
  return last === undefined ? 0 : last.offset + last.rows.length;
};
