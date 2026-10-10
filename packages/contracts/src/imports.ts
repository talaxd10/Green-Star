// The Excel import: a spreadsheet read into a draft file.

import { z } from "zod";
import { Day, Name, Uuid } from "./common.ts";
import type { Trust } from "./customers.ts";

export const IMPORT_FIELD_NAMES = ["mark", "phone", "name", "amount", "cartons", "weight", "city", "goods"] as const;
export type ImportFieldName = (typeof IMPORT_FIELD_NAMES)[number];

/** The spreadsheet itself, as the browser read it. At most 10 MB. */
const SheetFile = {
  filename: z.string().trim().min(1).max(255),
  /** The file's bytes, base64. */
  content: z.string().min(4, "The file is empty").max(14_000_000, "The file is larger than 10 MB"),
};

const Column = z.number().int().min(0).max(199);

/** Field to column, 0-based. A field left out is not in the sheet. */
export const ImportMappingShape = z.strictObject({
  mark: Column.optional(),
  phone: Column.optional(),
  name: Column.optional(),
  amount: Column.optional(),
  cartons: Column.optional(),
  weight: Column.optional(),
  city: Column.optional(),
  goods: Column.optional(),
});

/**
 * POST /v1/imports/preview. Reads the file and saves nothing. Without a sheet,
 * header row or mapping, each is guessed; send them back changed to read it
 * again another way.
 */
export const ImportPreviewRequest = z.strictObject({
  ...SheetFile,
  sheet: z.string().min(1).max(100).optional(),
  headerRow: z.number().int().min(0).max(10_000).optional(),
  mapping: ImportMappingShape.optional(),
});
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

/** What to do with a row the system could not match to a customer, or matched to the wrong one. */
export const ImportDecision = z.union([
  z.strictObject({ rowNo: z.number().int().min(1), customerId: Uuid }),
  z.strictObject({
    rowNo: z.number().int().min(1),
    newCustomer: z.strictObject({ name: Name, phone: z.string().trim().max(40).optional(), mark: z.string().trim().max(80).optional() }),
  }),
  z.strictObject({ rowNo: z.number().int().min(1), skip: z.literal(true) }),
]);
export type ImportDecision = z.infer<typeof ImportDecision>;

/**
 * POST /v1/imports. Makes the draft file: the rows go to the customers they
 * belong to, one consignment per customer (his rows added up). Nothing is
 * charged until the file is confirmed.
 */
export const ImportRequest = z.strictObject({
  ...SheetFile,
  sheet: z.string().min(1).max(100),
  headerRow: z.number().int().min(0).max(10_000),
  mapping: ImportMappingShape,
  code: z.string().trim().min(1, "Enter the file's code").max(40),
  arrivedOn: Day.optional(),
  decisions: z.array(ImportDecision).max(5000).default([]),
});
export type ImportRequest = z.infer<typeof ImportRequest>;

export interface ImportMatch {
  customerId: string;
  customerName: string;
  trust: Trust;
  /** phone, mark or mark_prefix */
  matchedBy: string;
  /** The phone says one customer and the mark another. The phone wins unless he says otherwise. */
  conflict: boolean;
}

export interface ImportPreviewRow {
  rowNo: number;
  raw: Record<string, string>;
  mark: string | null;
  phone: string | null;
  phoneTyped: string | null;
  name: string | null;
  amountUsdCents: number | null;
  cartons: number | null;
  weightGrams: number | null;
  city: string | null;
  goods: string | null;
  problems: string[];
  match: ImportMatch | null;
}

export interface ImportPreview {
  filename: string;
  sha256: string;
  /** The draft or file this exact spreadsheet already became. */
  alreadyImported: { shipmentId: string; code: string } | null;
  sheets: string[];
  sheet: string;
  headerRow: number;
  /** The first rows of the sheet as text, to pick the header row and see the columns. */
  top: string[][];
  headers: string[];
  mapping: Partial<Record<ImportFieldName, number>>;
  /** A file code found in the file name. */
  suggestedCode: string | null;
  rows: ImportPreviewRow[];
  totals: { rows: number; matched: number; unmatched: number; withProblems: number; amountUsdCents: number };
}
