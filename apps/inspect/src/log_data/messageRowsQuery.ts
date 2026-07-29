import {
  InfiniteData,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
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

const messageRowsQueryKey = (handle: SampleHandle | undefined) => [
  "log_data",
  "message-rows",
  handle?.logFile ?? null,
  handle?.id ?? null,
  handle?.epoch ?? null,
];

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
  handle: SampleHandle | undefined,
  source: SampleMessagesData | undefined
): MessageRowsModel | undefined => {
  const query = useInfiniteQuery({
    queryKey: messageRowsQueryKey(handle),
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

export interface MessageRowTarget {
  /** Row position of the deep-linked message — undefined while pending,
   *  for unknown ids, and without a target. */
  index: number | undefined;
  /** Resolution (and its prefix pre-load) still settling — callers hold
   *  the rows query back (pass `useMessageRowsModel` no source) until this
   *  clears, so the list mounts with the target row resident. */
  pending: boolean;
}

/**
 * Resolve a `?message=` deep link against the source and pre-load the page
 * prefix covering it, in parallel — the rows query's forward walk would
 * reach a deep target in serialized page-sized steps. A deep link accepts
 * the prefix cost by design (it's the same data a scroll to the target
 * would load); the common near-the-top link stays cheap.
 *
 * The prefix lands via setQueryData at the rows-query key. That never
 * races a page fetch because of the `pending` contract above: the rows
 * query idles on skipToken until this settles.
 */
export const useMessageRowTarget = (
  handle: SampleHandle | undefined,
  source: SampleMessagesData | undefined,
  messageId: string | null | undefined
): MessageRowTarget => {
  const queryClient = useQueryClient();
  const enabled = handle !== undefined && source !== undefined && !!messageId;
  const query = useQuery({
    queryKey: [...messageRowsQueryKey(handle), "target", messageId ?? null],
    queryFn:
      handle !== undefined && source !== undefined && messageId
        ? async (): Promise<number | null> => {
            const position = await source.resolveMessage(messageId);
            if (position === undefined) {
              return null;
            }
            const rowsKey = messageRowsQueryKey(handle);
            const existing =
              queryClient.getQueryData<InfiniteData<MessageRowsPage, number>>(
                rowsKey
              );
            // pages are always full-sized except a final page at the
            // conversation's end, so an existing prefix that stops short of
            // `position` ends on a page boundary — extend from there
            const have = existing ? loadedCount(existing.pages) : 0;
            if (position >= have) {
              const params: number[] = [];
              for (let lo = have; lo <= position; lo += kMessageRowsPageSize) {
                params.push(lo);
              }
              const pages = await Promise.all(
                params.map((lo) =>
                  source.getRows({
                    cursor: lo === 0 ? null : { position: lo },
                    direction: "forward",
                    limit: kMessageRowsPageSize,
                  })
                )
              );
              queryClient.setQueryData<InfiniteData<MessageRowsPage, number>>(
                rowsKey,
                {
                  pages: [...(existing?.pages ?? []), ...pages],
                  pageParams: [...(existing?.pageParams ?? []), ...params],
                }
              );
            }
            return position;
          }
        : skipToken,
    gcTime: kSampleGcTimeMs,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return {
    index: typeof query.data === "number" ? query.data : undefined,
    // an errored resolution settles too: the list mounts at the top rather
    // than holding the whole tab on a failed deep link
    pending: enabled && query.isPending,
  };
};
