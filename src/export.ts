import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import type { SalesforceRecord } from "./salesforce.js";

/** Appiattisce i record: niente `attributes`, relazioni in dot-notation. */
export function flattenRecord(
  record: SalesforceRecord,
  prefix = "",
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(record)) {
    if (key === "attributes") continue;
    const path = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      out[path] = "";
    } else if (Array.isArray(value)) {
      out[path] = JSON.stringify(value);
    } else if (typeof value === "object") {
      const nested = value as SalesforceRecord;
      // Sub-query: { totalSize, done, records: [...] }
      if (Array.isArray((nested as { records?: unknown }).records)) {
        out[path] = JSON.stringify(
          ((nested as { records: SalesforceRecord[] }).records ?? []).map((r) =>
            flattenRecord(r),
          ),
        );
      } else {
        flattenRecord(nested, path, out);
      }
    } else {
      out[path] = value;
    }
  }
  return out;
}

export function collectColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(row[col])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export interface ExportResult {
  filePath: string;
  format: "csv" | "json";
  rowCount: number;
  columns: string[];
  preview: Record<string, unknown>[];
}

export function writeExport(
  records: SalesforceRecord[],
  format: "csv" | "json",
  baseName: string,
): ExportResult {
  mkdirSync(config.exportDir, { recursive: true });
  const slug = baseName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "query";
  const fileName = `${slug}_${timestamp()}.${format}`;
  const filePath = join(config.exportDir, fileName);

  const rows = records.map((r) => flattenRecord(r));
  const columns = collectColumns(rows);

  if (format === "csv") {
    writeFileSync(filePath, toCsv(rows, columns), "utf8");
  } else {
    writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }

  return {
    filePath,
    format,
    rowCount: rows.length,
    columns,
    preview: rows.slice(0, 10),
  };
}
