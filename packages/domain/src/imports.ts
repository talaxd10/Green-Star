// Reading a spreadsheet into the rows of a file.
//
// The real China files have not arrived, so nothing here assumes a layout.
// A sheet is read as rows of text. The header row is found, each column is
// guessed from its heading (English, Chinese, Arabic and Kurdish words the
// files are likely to use), and the CEO can change any guess before
// anything is saved. The same rules run in the API and in the screen.

import { normalizeMark, normalizePhone } from "./customers.ts";

/** What a column can hold. Only the amount is required, and one of mark, phone or name. */
export const IMPORT_FIELDS = ["mark", "phone", "name", "amount", "cartons", "weight", "city", "goods"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Field to the column it is read from (0-based), or absent when the sheet has no such column. */
export type ImportMapping = Partial<Record<ImportField, number>>;

/** Words a heading may contain, lower case. The first field whose word appears wins, in this order. */
const HEADINGS: readonly [ImportField, readonly string[]][] = [
  ["phone", ["phone", "mobile", "tel", "whatsapp", "电话", "手机", "هاتف", "موبايل", "ژمارە", "تەلەفۆن", "رقم"]],
  ["mark", ["mark", "唛头", "唛", "code", "marks", "شعار", "مارك", "مارک", "کۆد"]],
  ["weight", ["weight", "kg", "g.w", "gw", "重量", "毛重", "公斤", "وزن", "کێش"]],
  ["cartons", ["ctn", "ctns", "carton", "cartons", "pkgs", "packages", "qty", "pcs", "件数", "箱数", "数量", "كرتون", "کارتۆن", "عدد"]],
  ["amount", ["collect", "amount", "total", "usd", "price", "cost", "金额", "总额", "总价", "应收", "运费", "مبلغ", "المبلغ", "بڕ", "پارە", "$"]],
  ["city", ["city", "城市", "目的地", "مدينة", "شار"]],
  ["goods", ["goods", "description", "item", "product", "remark", "note", "品名", "货物", "备注", "بضاعة", "کاڵا", "تێبینی"]],
  ["name", ["name", "customer", "client", "consignee", "收货人", "客户", "姓名", "الاسم", "اسم", "ناو", "کڕیار"]],
];

const clean = (cell: unknown): string => (cell === null || cell === undefined ? "" : String(cell)).replace(/\s+/g, " ").trim();

/** The field a heading most likely names, or null. */
export function guessField(heading: string): ImportField | null {
  const text = clean(heading).toLowerCase();
  if (text === "") return null;
  // A price per kilogram is neither the weight nor the amount to collect.
  if (/(per|\/)\s*kg|单价|unit price|price per/.test(text)) return null;
  for (const [field, words] of HEADINGS) {
    for (const word of words) {
      // Short Latin words must stand alone ("tel", not "hotel"); others may sit inside the heading.
      if (/^[a-z.]{1,4}$/.test(word)) {
        if (new RegExp(`(^|[^a-z])${word.replace(".", "\\.")}([^a-z]|$)`).test(text)) return field;
      } else if (text.includes(word)) {
        return field;
      }
    }
  }
  return null;
}

/** Guesses every column of a header row. Each field goes to the first column that names it. */
export function guessMapping(headers: readonly string[]): ImportMapping {
  const mapping: ImportMapping = {};
  headers.forEach((heading, index) => {
    const field = guessField(heading);
    if (field !== null && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

/**
 * The row the headings are on: the first of the top 20 rows where at least
 * two columns name a field and one of them is the amount, the mark, the
 * phone or the name. 0 when none does.
 */
export function findHeaderRow(rows: readonly (readonly unknown[])[]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const mapping = guessMapping((rows[i] ?? []).map(clean));
    const named = Object.keys(mapping).length;
    if (named >= 2 && (mapping.amount !== undefined || mapping.mark !== undefined || mapping.phone !== undefined || mapping.name !== undefined)) {
      return i;
    }
  }
  return 0;
}

/**
 * Dollars as a spreadsheet writes them, to cents: 62, "62.5", "$1,234.50".
 * A comma is a thousands mark, as on every screen here, so "62,5" is not an
 * amount. null when it is not one; a negative amount is not one either.
 */
export function readDollars(cell: unknown): number | null {
  if (typeof cell === "number") {
    if (!Number.isFinite(cell) || cell < 0) return null;
    return Math.round(cell * 100);
  }
  const text = clean(cell).replace(/^(usd|us\$|\$)\s*/i, "").replace(/\s*(usd|\$|دولار)$/i, "");
  if (text === "") return null;
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,4})?$|^\d+(\.\d{1,4})?$/.test(text)) return null;
  const value = Number(text.replaceAll(",", ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** A whole number of cartons, or null. */
export function readCount(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isInteger(cell) && cell >= 0 ? cell : null;
  const text = clean(cell).replace(/\s*(ctns?|cartons?|pcs|箱|件)$/i, "");
  return /^\d{1,6}$/.test(text) ? Number(text) : null;
}

/** Kilograms to grams, or null. */
export function readKilograms(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) && cell >= 0 ? Math.round(cell * 1000) : null;
  const text = clean(cell).replace(/\s*(kgs?|公斤|كغ)$/i, "").replaceAll(",", "");
  return /^\d+(\.\d{1,3})?$/.test(text) ? Math.round(Number(text) * 1000) : null;
}

export interface ImportRow {
  /** The row number as the spreadsheet shows it, from 1. */
  rowNo: number;
  /** Every cell of the row as text, keyed by its heading (or "Column 3" when it has none). */
  raw: Record<string, string>;
  mark: string | null;
  /** In international form. */
  phone: string | null;
  /** The phone as written, when it could not be read. */
  phoneTyped: string | null;
  name: string | null;
  amountUsdCents: number | null;
  cartons: number | null;
  weightGrams: number | null;
  city: string | null;
  goods: string | null;
  /** What is wrong with the row, for a person. Empty when it can be imported. */
  problems: string[];
}

/** What the sheet gives, row by row, from the row after the headings. Blank rows and total rows are left out. */
export function readRows(rows: readonly (readonly unknown[])[], headerRow: number, mapping: ImportMapping): ImportRow[] {
  const headers = (rows[headerRow] ?? []).map(clean);
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  const keys = Array.from({ length: width }, (_, i) => {
    const heading = headers[i] ?? "";
    return heading === "" || headers.indexOf(heading) !== i ? `Column ${i + 1}` : heading;
  });
  const at = (row: readonly unknown[], field: ImportField): unknown => {
    const index = mapping[field];
    return index === undefined ? undefined : row[index];
  };
  const text = (row: readonly unknown[], field: ImportField): string | null => {
    const value = clean(at(row, field));
    return value === "" ? null : value;
  };

  const out: ImportRow[] = [];
  rows.forEach((row, index) => {
    if (index <= headerRow) return;
    if (row.every((cell) => clean(cell) === "")) return;
    const mark = text(row, "mark");
    const phoneTyped = text(row, "phone");
    const name = text(row, "name");
    const amountCell = text(row, "amount");
    // The sum line: "Total" where a name or mark would be, or anywhere on a row that names nobody.
    const who = mark ?? phoneTyped ?? name;
    const isTotal = (value: unknown) => /^(total|sum|grand total|合计|总计|المجموع|کۆ)(?![a-z])/i.test(clean(value));
    if ([mark, name, phoneTyped].some(isTotal) || (who === null && row.some(isTotal))) return;

    const raw: Record<string, string> = {};
    keys.forEach((key, i) => {
      const value = clean(row[i]);
      if (value !== "") raw[key] = value;
    });

    const problems: string[] = [];
    const phone = phoneTyped === null ? null : normalizePhone(phoneTyped);
    if (phoneTyped !== null && phone === null) problems.push(`"${phoneTyped}" is not a phone number`);
    if (who === null) problems.push("Nothing says whose goods these are");
    const amountUsdCents = amountCell === null ? null : readDollars(at(row, "amount"));
    if (mapping.amount === undefined) problems.push("No column is the amount to collect");
    else if (amountCell === null) problems.push("No amount");
    else if (amountUsdCents === null) problems.push(`"${amountCell}" is not an amount in dollars`);
    const cartonsCell = text(row, "cartons");
    const cartons = cartonsCell === null ? null : readCount(at(row, "cartons"));
    if (cartonsCell !== null && cartons === null) problems.push(`"${cartonsCell}" is not a number of cartons`);
    const weightCell = text(row, "weight");
    const weightGrams = weightCell === null ? null : readKilograms(at(row, "weight"));
    if (weightCell !== null && weightGrams === null) problems.push(`"${weightCell}" is not a weight in kilograms`);

    out.push({
      rowNo: index + 1,
      raw,
      mark: mark === null ? null : normalizeMark(mark),
      phone,
      phoneTyped,
      name,
      amountUsdCents,
      cartons,
      weightGrams,
      city: text(row, "city"),
      goods: text(row, "goods"),
      problems,
    });
  });
  return out;
}

/** A file code in a file name: "GSSK6926 Sulaymaniyah.xlsx" is GSSK6926. null when there is none. */
export function codeFromFilename(filename: string): string | null {
  const match = /([A-Za-z]{2,6}[-_ ]?\d{3,8})/.exec(filename.replace(/\.[a-z0-9]+$/i, ""));
  return match === null ? null : (match[1] as string).toUpperCase().replace(/[-_ ]/g, "");
}
