# A data access interface for the log listing

Status: proposed (design only — no code yet). Companion to
[db-backed-listing-plan.md](db-backed-listing-plan.md), which documents the
paginated listing as it currently exists on this branch.

## Summary

The paginated log listing works, but its layering has problems: the data
layer depends on react-query internals, and view code (a React component)
decides which database records the listing includes. This doc proposes a
transitional restructuring:

1. Put all listing reads behind a small interface shaped like scout's
   server API: methods take a filter, a sort order, and pagination, and
   return one page of rows plus a total count.
2. Let the implementation of that interface be as inefficient as IndexedDB
   forces it to be (scan every record, hold results in memory) — but keep
   that cost invisible above the interface.
3. Move the "snapshot" cache (explained below) inside the implementation,
   replacing a react-query entry with a plain internal cache.
4. Encode the rules for which records appear in the listing ("membership")
   as filter conditions passed through the interface, instead of a function
   the view supplies.

The goal is that when we later replace IndexedDB with a better store (for
example SQLite compiled to WebAssembly), only the implementation behind the
interface changes. Higher-level code never learns that today's
implementation reads everything into memory, so nothing above the interface
gets built on that assumption.

## Background: how the listing reads data today

A replication service continuously syncs the view server's log directory
into IndexedDB in the browser. The listing UI reads from IndexedDB, not
from the server.

Because most useful filters and sorts cannot use an IndexedDB index (see
the constraints section of the plan doc), any filtered, sorted, counted
listing requires scanning every record in the scope. The branch pays for
that scan once per (filter, sort) combination and reuses it:

- **The snapshot.** One scan produces the ordered list of primary keys
  (file paths) of every record that matches the filter, in sort order.
  The count comes free (it's the list's length). This is cached.
- **Pages.** A page of 500 rows is served by slicing 500 keys out of the
  snapshot and bulk-reading just those records. Pages are cheap, and all
  pages of one query slice the same frozen ordering, so concurrent
  replication writes can't cause duplicates or gaps mid-scroll.
- **Freshness.** When replication writes new data, a throttled invalidation
  marks the cached snapshot and pages stale; they rebuild on next use.

That two-level scheme is sound and this proposal keeps it. The problems are
in *where* the pieces live.

## The problems

### 1. The data layer depends on react-query

The snapshot is cached as a react-query cache entry, and the page-reading
function fetches it by calling `queryClient.fetchQuery` from *inside*
another query's fetch function (`log_data/logsListingRead.ts`,
`fetchLogsListingSnapshot`). Correctness depends on subtle react-query
behavior: `staleTime: Infinity` meaning "fresh until explicitly
invalidated", and `fetchQuery` (not `ensureQueryData`) so that an
invalidated snapshot is rebuilt and awaited rather than served stale.

react-query is a UI-level caching library. Having the storage layer depend
on its cache semantics means none of this survives a storage swap, and
anyone touching the data layer must first understand react-query
internals.

### 2. A React component decides what's in the database's result set

The view supplies a function called `toRow` (built in `LogsPanel.tsx`) that
converts a stored record into a grid row — and also returns `undefined` for
records the current view should not list at all. Three rules hide inside
those `undefined` returns:

- In folder view, only records directly inside the current directory are
  listed (not records in subdirectories).
- When "Show Retried Logs" is off, records marked as retried runs are
  dropped.
- Records whose file names don't parse as valid log identities are dropped.

Each of these is a predicate over stored data — a WHERE clause — but it's
implemented as JavaScript closed over component state. That has already
produced visible scar tissue:

- **The `universe` string.** Cache keys must be plain values, and `toRow`
  is a function, so a string (`mode + directory + retried-toggle`) is
  manually maintained as a stand-in for "which version of `toRow` produced
  these rows". Forgetting to include something in this string is a stale
  cache bug.
- **A duplicated scan prefix.** The query also carries a directory prefix
  that narrows the scan, which must be kept manually consistent with what
  `toRow` accepts. A code comment warns that getting this wrong "would
  silently drop matching rows". Two representations of one fact,
  coordinated only by a comment.
- **The rules are implemented three times.** Once in `toRow` for the
  listing, once in `isCandidate` for the overview (aggregate counts,
  folder list), and retried-hiding a third time inside `readLogsOverview`
  itself. Nothing enforces that they agree.

### 3. Filters and sorts are evaluated through view code

A filter like "score > 0.5" names a *grid column*, not a stored field.
There is no declared mapping from column name to stored data. Instead the
query evaluator calls the grid's own column accessor functions
(`getValue`, `getComparator`, `getFilterType` from `useLogListColumns`) to
read and compare values. Those functions close over the score schema,
which arrives asynchronously — so a second stand-in string
(`accessorsKey`) exists to key caches by "which version of the accessors
was in effect".

This one is the hardest to fully fix (see "What we are deliberately not
doing yet"), but the proposal shrinks it.

## The proposal

### One interface, scout's shape

Scout's UI queries a server: `getTranscripts(dir, filter, orderBy,
pagination)` returns one page plus a total count, and the UI wraps that in
react-query hooks. We build the same shape with IndexedDB behind it.

The interface needs more than one method, because the listing page needs
more than rows:

```ts
interface LogListingData {
  // One page of the listing, plus facts about the whole result set.
  getPage(
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    pagination: Pagination
  ): Promise<{
    // This page's rows. Whether these are stored records (shaped into
    // display rows above the interface) or already-shaped view rows is
    // tied to the transitional accessor question — see "Two kinds of
    // column names" below.
    items: Row[];
    // Count of ALL rows matching the filter, not just this page — the
    // footer count.
    totalCount: number;
    // Distinct task_ids across ALL matching rows. The pending-task
    // overlay drops a "pending" row once any real row exists for its
    // task; with pagination, the loaded pages alone can't prove a row
    // does NOT exist, so this whole-result fact rides along.
    universeTaskIds: string[];
    nextCursor: Cursor | null;
  }>;

  // Rows whose searchable text contains the term, across the WHOLE
  // result — loaded and unloaded pages alike — in result order. Backs
  // the Find band.
  getMatches(
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    term: string
  ): Promise<Array<{
    // Stable row id — drives match highlighting and selection.
    id: string;
    // Index in the filtered+sorted result: the same coordinate page
    // cursors use, so "jump to this match" becomes "load pages through
    // this position".
    position: number;
    // The row's sort-column values, so rows that exist only in memory
    // (pending tasks) can be merge-sorted into match order above the
    // interface without loading the matched row itself.
    orderValues?: Record<string, unknown>;
  }>>;

  // Aggregates about a directory that the listing page needs beyond the
  // queried rows — one scan produces all of them.
  getOverview(
    dir: string,
    options: {
      // Folder view: also derive this directory's immediate
      // subdirectories (name + log count each).
      folderDir?: string;
      // Affects the counts below, mirroring the listing's own
      // retried-hiding.
      showRetriedLogs: boolean;
    }
  ): Promise<{
    // Distinct task_ids anywhere under dir — the pending-task overlay's
    // input (deliberately wider than the current filter).
    taskIds: string[];
    // Rows in the view universe (retried-hidden excluded).
    fileCount: number;
    // Of those, logs still running.
    startedCount: number;
    // Rows that retried-hiding removed — drives whether the
    // "Show Retried Logs" toggle appears at all.
    retriedCount: number;
    // Set when exactly one row exists (single-log workspace redirect).
    soleFileName?: string;
    folders: Array<{ name: string; itemCount: number }>;
  }>;
}
```

Why `getMatches` is on the interface at all, rather than an implementation
detail: find results must be true across the *whole* filtered result — the
match count and jump-to-match navigation include rows on pages that were
never loaded, which only the data layer can answer. What stays above the
interface is all the find *behavior*: debouncing the typed term, tracking
the current match, and asking the page query to load pages through an
unloaded match's position. Pulling matches inside the implementation would
force that UI state down with it. So it's a query method — conceptually
`getPage` with a different projection (positions instead of rows).

One honest wart in `getMatches`: it cannot be expressed as a filter
condition, because matching runs against a row's *on-screen text* — the
formatted cell values of the currently visible columns (a formatted date,
a model's display name) — which stored fields can't reproduce. So the
function that produces a row's searchable text is view code that crosses
the interface, transitionally, the same way the view-level column
accessors do (see "Two kinds of column names"). It shares their exit
path.

Why `getOverview` is a separate method rather than a `getPage` variant:
its numbers deliberately span *different* membership rules in one answer —
`retriedCount` counts exactly the rows the listing's filter excludes,
`taskIds` covers the whole directory regardless of the current filter, and
`folders` derives from the recursive universe while the folder-view
listing shows only direct children. No single filter produces all of
those, but one scan does.

The react-query hooks (`useDatabaseLogsListingQuery` and friends) stay, but
become thin wrappers that call these methods — exactly how scout's
`useServerTranscriptsInfinite` wraps `api.getTranscripts`. No query ever
fetches another query from inside its fetch function.

Pagination uses scout's `Pagination` shape
(`packages/inspect-common/src/query/types.ts`): a cursor, a direction
(`"forward"` or `"backward"`), and a limit. Cursors stay opaque to callers
and mean "position in the filtered and sorted result". Today's
implementation realizes that as an offset into the snapshot's key list; a
future SQL implementation can realize it differently without changing any
caller. (The Find band's "load pages until this position is loaded"
behavior already uses exactly this meaning, so it survives unchanged.)

The interface supports both directions from the start, even though today's
UI only pages forward (the grid has no scroll-up fetch trigger, and the
react-query hook keeps every loaded page rather than a bounded window).
Backward support costs almost nothing here — with an offset cursor, the
backward page is just the key-list slice *before* the cursor — whereas
scout's keyset cursors make backward paging genuinely harder. And it's
needed soon: the planned bounded-window rework (drop far-away pages, fetch
pages on demand as the user scrolls back up) is exactly a consumer of
backward paging. Building the interface without `direction` would bake
today's forward-only UI behavior into the layer that's supposed to outlive
it.

### The snapshot becomes a private cache

The implementation keeps the scan-once-page-cheap scheme, but the snapshot
moves from a react-query entry to an ordinary cache inside the
implementation, keyed by the (filter, orderBy) values. A cache of one or
two entries is enough: the listing re-reads the same query repeatedly, and
a changed filter or sort means a fresh scan anyway.

What the react-query placement currently provides, and how the internal
cache replaces it:

| react-query gave us | replacement |
| --- | --- |
| Deduplication (concurrent page fetches and the Find query share one scan) | cache the *promise*, not just the result |
| Reuse across pages | the cache itself |
| Eviction (`gcTime`) | one/two entries, overwritten on key change — strictly less memory |
| Invalidation via the shared key root | an explicit step, below |
| No stale-value trap (`fetchQuery` vs `ensureQueryData`) | not needed — "cleared means the next call rebuilds and awaits" is the obvious semantics of a plain cache |

**Invalidation** becomes two explicit steps in
`invalidateDatabaseLogsListings`: first clear the implementation's internal
cache, then invalidate the react-query keys so the hooks refetch. That
order matters — refetches must not be served the pre-write snapshot. This
is the one coordination point the restructuring adds, in exchange for
deleting the query-inside-query mechanism.

One thrash hazard to design around: the listing query and the overview run
*different* filters (the overview needs the unfiltered universe, and counts
that include what retried-hiding removed). A single-entry cache shared by
both would rebuild on every alternation. Give them separate slots, or key
the cache by the full filter value with room for both.

### Membership becomes filter conditions

The rules currently hidden in `toRow`'s `undefined` returns move into the
filter `Condition` passed through the interface. The view composes
`scopeCondition AND userFilter` and hands over one condition. The rules
still *originate* in the view (only the view knows it's in folder mode),
but as declarative data the implementation can execute, test, and
eventually compile to SQL — not as a closure it must trust.

Checked against the actual condition language
(`packages/inspect-common/src/query/types.ts`, SQL-style operators):

- **Folder view (direct children only).** Expressible today as
  `name LIKE 'dir/%' AND name NOT LIKE 'dir/%/%'`, but LIKE requires
  wildcard-escaping paths containing `%` or `_` — a silent-corruption
  hazard. Cleaner: a `parent_dir` column (`parent_dir = 'dir'`), derivable
  from the file path during the scan now, and a real stored (and indexed)
  column later.
- **Retried-hiding.** `retried = false` (exact representation TBD). Note
  that "retried" is currently computed by *grouping* rows during the scan
  (`computeLogsWithRetried`), not stored per record. The implementation
  already derives it before filtering, so it can be exposed as a queryable
  column immediately; persisting it at write time (already on the plan
  doc's roadmap) is what makes it a real stored column later.
- **Valid log identity.** A parse check, not expressible in the operator
  set — and it shouldn't be. Either replication already only writes rows
  that parse (verify this), or a validity flag gets stored at write time
  and the condition is `IS NOT NULL` on it. Bookkeeping either way.

With membership encoded this way, `toRow` shrinks to pure shaping (record →
display row), applied only to the returned page, above the interface. What
gets deleted as a consequence:

- the `universe` string — the filter condition's value *is* the cache key;
- the manually-coordinated scan prefix — the directory scope is in the
  condition;
- the three separate implementations of the membership rules.

One caution: nothing shaping-only (like the click-through URL, which
depends on the current directory) may sneak back into cache identity.
Shaping runs per page above the interface, so it shouldn't need to.

### Two kinds of column names, one resolver

Encoding membership as conditions means condition columns now come from two
places:

- **Record-level columns** (`name`, `parent_dir`, `retried`, `task_id`,
  `status`, `mtime`, …): evaluated by the implementation directly against
  stored records. These are the terms a future backend can push into
  indexed WHERE clauses.
- **View-level columns** (`score_<scorer>/<metric>`, `percentCompleted`,
  `model`, …): still evaluated through the grid's accessor functions over
  shaped rows, because no declared mapping from these names to stored data
  exists yet.

The implementation's condition evaluator therefore needs a resolver: try
the record-level schema first, fall back to the view accessors. That
resolver is the beginning of a declared column schema — it can grow one
column at a time as mappings get written down, shrinking the view-level
residue, instead of requiring a big-bang schema migration.

Until the residue is gone, the accessor functions (and their `accessorsKey`
stand-in, since the score schema arrives asynchronously) still have to
reach the implementation somehow. Two options, to be decided during
implementation:

- construct the data-access object per view, passing accessors in once
  (simple, but the object must be rebuilt when the score schema lands); or
- pass accessors per call and include `accessorsKey` in the internal cache
  key (uglier signature, no lifecycle management).

Either is acceptable as a transitional wart, because it's now confined to
one place with a written exit path.

## What we are deliberately not doing yet

- **Declaring the full column schema.** Score columns are an open-ended
  namespace (`score_<scorer>/<metric>`) that will never be pre-expanded
  into real columns; some display columns are computed in view code. The
  general fix — evaluate every condition against stored data, via declared
  fields or JSON paths — is where a real database eventually forces us,
  but it's not required to fix the layering. The resolver above lets it
  happen incrementally.
- **Leaving IndexedDB.** A full scan per (filter, sort) is unavoidable in
  the general case on *any* backend without a per-path index. What is
  IndexedDB-specific is the cost profile: every record must cross into
  JavaScript to be tested (structured-clone deserialization), and sorting
  requires holding the full row set in JS memory. A real engine scans with
  filter pushdown and page-sized memory. That's why the interface promises
  *semantics* (filter, sort, page, count) and stays silent about cost —
  the scan survives the backend swap; its cost profile doesn't; so nothing
  above the interface may be tuned around it.
- **Changing the paging scheme.** Frozen-ordering snapshots with
  offset-based cursors stay. Scout's keyset cursors need index-walkable
  sorts, which IndexedDB can't provide for realistic queries (see the plan
  doc's constraints).

## Consequences

Gains:

- The data layer is react-query-free; the storage swap surface is one
  interface.
- Membership rules are declarative, executed in one place, and become
  indexable query terms on a future backend.
- The `universe` string, the duplicated scan prefix, and the
  query-inside-query mechanism are deleted.
- Cache-only fallback modes (database failed to open, out-of-namespace
  directories) become invisible implementation details of the interface.

Costs:

- Invalidation is now an explicit two-step (clear internal cache, then
  invalidate react-query keys) that we own and must order correctly.
- The internal cache is hand-rolled state: it must cache promises for
  deduplication, and must be per-instance (or resettable) so tests don't
  fight singleton state.
- A slightly weaker consistency guarantee: today, all pages of one
  react-query refetch cycle provably share one snapshot. With a small
  internal cache, a filter change mid-scroll evicts the old entry; in
  practice old-key page windows are unobserved and don't refetch, so this
  is a comment, not a mechanism — but it's a real difference.
- Prerequisites: derive `parent_dir` and `retried` as queryable columns in
  the implementation now; persist them at write time later; verify (or
  enforce) at the write path that only valid log identities are written.

## Open questions

- What `getPage` returns in `items`: stored records (with display shaping
  applied above the interface, per page) or already-shaped view rows. Tied
  to the per-view vs. per-call accessor question below.
- Whether `getOverview`'s membership inputs (`showRetriedLogs`, the
  validity rule) should also be expressed as conditions for symmetry, or
  stay as named options since the method intentionally reports across
  several membership variants at once.
- Per-view construction vs. per-call accessors for the transitional
  view-level column evaluation (see the resolver section).
- Representation of `retried` in conditions (`= false` vs `IS NULL`
  semantics for never-retried rows).
- Whether the samples listing (which still uses the old fully-in-memory
  query) adopts the same interface now or later.
