import type { FilterType } from "@tsmono/inspect-components/columnFilter";
import { basename, dirname } from "@tsmono/util";

import { kModelNone } from "../../constants";
import { parseLogFileName } from "../../utils/evallog";
import type { LogListingRow } from "../logListing";
import type { ScorerMap } from "../scoreSchema";

import type { ValueComparator } from "./types";

/**
 * The log listing's column semantics — what a condition or sort column
 * name *means* — declared as data-layer code over stored records, not
 * borrowed from grid column definitions ("the boundary rule",
 * design/listing-data-interface.md). The grid's column defs consume these
 * same semantics for their display config, so the two can't drift; the
 * listing data evaluates queries through the schema directly, so no view
 * code sits in the evaluation path.
 */
export interface LogColumnSchema {
  /** A record's raw value for a column id (unknown ids read the record
   *  field of that name). */
  getValue: (log: LogListingRow, columnId: string) => unknown;
  /** Per-column value comparator; `undefined` means the default
   *  (string-ish, missing-smallest) compare. */
  getComparator: (columnId: string) => ValueComparator | undefined;
  /** Per-column filter type (type-aware filter coercion and editors). */
  getFilterType: (columnId: string) => FilterType | undefined;
  /** Cache identity: the scorer schema the dynamic score/metric columns
   *  derive from (it arrives asynchronously — queries evaluated through
   *  the schema must carry this in their keys). */
  key: string;
}

/** Missing values (null/undefined/""/NaN) compare as smallest — first
 *  ascending, last descending once the listing query negates for DESC —
 *  matching the AG-default comparator the pre-TanStack log list used.
 *  Missing values need explicit handling: returning 0 for NaN pairs
 *  violates transitivity and scrambles the non-NaN rows too. */
const isMissingNumber = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === "" ||
  (typeof v === "number" && Number.isNaN(v));

export const numberCompare: ValueComparator = (a, b) => {
  const aMissing = isMissingNumber(a);
  const bMissing = isMissingNumber(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return -1;
  if (bMissing) return 1;
  return Number(a) - Number(b);
};

/** Missing dates coerce to epoch 0 (smallest), like the shared grid date
 *  comparator this mirrors. */
export const dateCompare: ValueComparator = (a, b) => {
  const timeA = a ? new Date(a as string | number | Date).getTime() : 0;
  const timeB = b ? new Date(b as string | number | Date).getTime() : 0;
  return timeA - timeB;
};

/**
 * Sort/filter value for the Completed column. Never-completed logs (status
 * `started`, including currently-running evals) have no completion date —
 * it arrives as `""` or undefined; fall back to the timestamp embedded in
 * the log file name so a Completed-descending sort slots them by recency —
 * a just-started eval surfaces at the top — instead of coercing the
 * missing date to epoch 0 and sinking them to the bottom.
 */
export const completedAtFallback = (
  completedAt: string | null | undefined,
  name: string
): string | undefined =>
  completedAt || parseLogFileName(basename(name)).timestamp?.toISOString();

const primaryModel = (log: LogListingRow): string | undefined => {
  if (log.model && log.model !== kModelNone) return log.model;
  const roles = log.model_roles ? Object.values(log.model_roles) : [];
  return roles[0];
};

interface ColumnSemantics {
  getValue: (log: LogListingRow) => unknown;
  comparator?: ValueComparator;
  filterType?: FilterType;
}

/** The static columns. Values mirror `buildLogListRow`'s projection (both
 *  read the same ingestion-derived record fields), so filtering/sorting
 *  through the schema agrees with what the grid displays. */
const kStaticColumns: Record<string, ColumnSemantics | undefined> = {
  task: {
    getValue: (log) => log.task || parseLogFileName(basename(log.name)).name,
  },
  model: { getValue: primaryModel },
  score: {
    getValue: (log) => log.primary_metric?.value,
    comparator: numberCompare,
    filterType: "number",
  },
  status: { getValue: (log) => log.status },
  completedAt: {
    getValue: (log) => completedAtFallback(log.completed_at, log.name),
    comparator: dateCompare,
    filterType: "date",
  },
  name: { getValue: (log) => basename(log.name) },
  path: { getValue: (log) => log.name },
  totalSamples: {
    getValue: (log) => log.header?.results?.total_samples,
    comparator: numberCompare,
    filterType: "number",
  },
  completedSamples: {
    getValue: (log) => log.header?.results?.completed_samples,
    comparator: numberCompare,
    filterType: "number",
  },
  sandbox: { getValue: (log) => log.header?.eval?.sandbox?.type },
  totalTokens: {
    getValue: (log) => log.derived?.total_tokens,
    comparator: numberCompare,
    filterType: "number",
  },
  duration: {
    getValue: (log) => log.derived?.duration,
    comparator: numberCompare,
    filterType: "number",
  },
  taskFile: { getValue: (log) => log.header?.eval?.task_file ?? undefined },
  taskArgs: { getValue: (log) => log.derived?.task_args },
  tags: {
    getValue: (log) =>
      log.header?.tags && log.header.tags.length > 0
        ? log.header.tags.join(", ")
        : "",
  },
  percentCompleted: {
    getValue: (log) => log.derived?.percent_completed,
    comparator: numberCompare,
    filterType: "number",
  },
  sampleErrors: {
    getValue: (log) => log.header?.sampleErrorCount,
    comparator: numberCompare,
    filterType: "number",
  },
  sampleLimits: { getValue: (log) => log.derived?.sample_limits },
  errorMessage: {
    getValue: (log) => log.header?.error?.message?.split("\n")[0] ?? "",
  },
  // Membership columns (see "Membership becomes filter conditions" in the
  // design doc). `parent_dir = <dir>` is the folder view's direct-children
  // rule; `retried = false` is retried-hiding, and relies on the mark
  // being total (see computeLogsWithRetried).
  parent_dir: { getValue: (log) => dirname(log.name) },
  retried: {
    getValue: (log) => log.retried ?? false,
    filterType: "boolean",
  },
};

const kScorePrefix = "score_";
const kMetricPrefix = "metric_";

const scoreValue = (
  log: LogListingRow,
  scorerName: string,
  metricName: string
): unknown => log.derived?.scores?.[scorerName]?.[metricName];

/**
 * Build the schema over a scorer map (see `useScoreSchema`). Dynamic
 * columns resolve by name shape: `score_<scorer>/<metric>` reads one
 * scorer's metric; `metric_<name>` aggregates across scorers (first
 * non-empty value in alphabetical scorer order — the same rule as the
 * by-metric grid column). Numeric-ness comes from the scorer map's value
 * types.
 */
export const createLogColumnSchema = (
  scorerMap: ScorerMap
): LogColumnSchema => {
  const metricScorers = new Map<
    string,
    { scorers: string[]; allNumeric: boolean }
  >();
  for (const [, { scorerName, metricName, valueType }] of Object.entries(
    scorerMap
  )) {
    const group = metricScorers.get(metricName) ?? {
      scorers: [],
      allNumeric: true,
    };
    group.scorers.push(scorerName);
    group.allNumeric = group.allNumeric && valueType === "number";
    metricScorers.set(metricName, group);
  }
  for (const group of metricScorers.values()) {
    group.scorers.sort((a, b) => a.localeCompare(b));
  }

  const resolve = (columnId: string): ColumnSemantics | undefined => {
    const staticColumn = kStaticColumns[columnId];
    if (staticColumn !== undefined) return staticColumn;
    if (columnId.startsWith(kScorePrefix)) {
      const key = columnId.slice(kScorePrefix.length);
      const slash = key.indexOf("/");
      if (slash < 0) return undefined;
      const scorerName = key.slice(0, slash);
      const metricName = key.slice(slash + 1);
      const numeric = scorerMap[key]?.valueType === "number";
      return {
        getValue: (log) => scoreValue(log, scorerName, metricName),
        comparator: numeric ? numberCompare : undefined,
        filterType: numeric ? "number" : undefined,
      };
    }
    if (columnId.startsWith(kMetricPrefix)) {
      const metricName = columnId.slice(kMetricPrefix.length);
      const group = metricScorers.get(metricName);
      if (group === undefined) return undefined;
      return {
        getValue: (log) => {
          for (const scorer of group.scorers) {
            const value = scoreValue(log, scorer, metricName);
            if (value !== undefined && value !== null && value !== "") {
              return value;
            }
          }
          return undefined;
        },
        comparator: group.allNumeric ? numberCompare : undefined,
        filterType: group.allNumeric ? "number" : undefined,
      };
    }
    return undefined;
  };

  return {
    // Declared columns answer even when their value is missing (a `??`
    // fallthrough to the raw field would, e.g., resurface the sentinel
    // model the `model` semantics deliberately hide); only unknown ids
    // read the record field of that name.
    getValue: (log, columnId) => {
      const column = resolve(columnId);
      return column !== undefined
        ? column.getValue(log)
        : (log as unknown as Record<string, unknown>)[columnId];
    },
    getComparator: (columnId) => resolve(columnId)?.comparator,
    getFilterType: (columnId) => resolve(columnId)?.filterType ?? "string",
    key: Object.entries(scorerMap)
      .map(([key, { valueType }]) => `${key}:${valueType}`)
      .sort()
      .join(","),
  };
};
