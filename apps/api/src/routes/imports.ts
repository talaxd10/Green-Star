// The Excel import: a spreadsheet becomes a draft file.
//
//   POST /v1/imports/preview   Read a spreadsheet and say what it would make. Saves nothing (a key is
//                              still sent, like every POST).
//   POST /v1/imports           Make the draft file from it
//
// The real China files have not arrived, so the import reads any layout:
// .xlsx, .xls, .csv and .ods. The columns are guessed from their headings and
// the CEO can change every guess. Each row is matched to a customer by phone,
// then mark, then mark prefix, the same way the database matches; a row
// nobody matches is given a customer by hand, or a new one is made, or it is
// left out. One customer's rows add up to one consignment. The draft charges
// nobody until it is confirmed, like a file typed in by hand.

import { createHash } from "node:crypto";
import {
  ImportPreviewRequest,
  ImportRequest,
  type ImportDecision,
  type ImportMatch,
  type ImportPreview,
  type ImportPreviewRow,
  type ShipmentDetail,
} from "@green-star/contracts";
import { codeFromFilename, findHeaderRow, guessMapping, normalizeMark, normalizePhone, readRows, type ImportMapping, type ImportRow } from "@green-star/domain";
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import type { Queryable } from "../db.ts";
import { ApiError, parse } from "../errors.ts";
import { read, write } from "../http.ts";
import { shipmentDetail } from "./shipments.ts";

const LIMIT = 15 * 1024 * 1024;
const MAX_ROWS = 5000;

interface Sheet {
  name: string;
  rows: unknown[][];
}

/** The spreadsheet's sheets as rows of cells. Refuses anything that is not a spreadsheet. */
function readWorkbook(filename: string, content: string): { bytes: Buffer; sheets: Sheet[] } {
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0) throw new ApiError(400, "file_unreadable", "The file is empty", { fields: { content: "The file is empty" } });
  if (bytes.length > 10 * 1024 * 1024) throw new ApiError(413, "file_too_large", "The file is larger than 10 MB");
  let book: XLSX.WorkBook;
  try {
    // Dates and formulas are read as the sheet shows them; nothing in the file is run.
    book = XLSX.read(bytes, { type: "buffer", cellDates: true, cellFormula: false, cellHTML: false, dense: true, sheetRows: MAX_ROWS + 50 });
  } catch {
    throw new ApiError(422, "file_unreadable", `${filename} could not be read as a spreadsheet`);
  }
  const sheets = book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const rows = sheet === undefined ? [] : (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: true }) as unknown[][]);
    return { name, rows: rows.map((row) => row.map((cell) => (cell instanceof Date ? cell.toISOString().slice(0, 10) : cell))) };
  });
  if (sheets.every((s) => s.rows.length === 0)) throw new ApiError(422, "file_unreadable", `${filename} has no rows`);
  return { bytes, sheets };
}

function pick(sheets: Sheet[], name: string | undefined): Sheet {
  if (name === undefined) return sheets.find((s) => s.rows.length > 0) ?? (sheets[0] as Sheet);
  const sheet = sheets.find((s) => s.name === name);
  if (sheet === undefined) throw new ApiError(400, "invalid_request", "That sheet is not in the file", { fields: { sheet: "That sheet is not in the file" } });
  return sheet;
}

const text = (cell: unknown) => (cell === null || cell === undefined ? "" : String(cell).replace(/\s+/g, " ").trim());

/** Who each row belongs to, by the database's own matching. */
async function matchRows(q: Queryable, rows: ImportRow[]): Promise<Map<number, ImportMatch>> {
  const out = new Map<number, ImportMatch>();
  for (const row of rows) {
    if (row.phone === null && row.mark === null) continue;
    const match = await q.first<{ customer_id: string; matched_by: string; conflict: boolean; display_name: string; trust: ImportMatch["trust"] }>(
      `select m.customer_id, m.matched_by, m.conflict, c.display_name, c.trust
       from gs_match_customer($1, $2) m join customers c on c.id = m.customer_id`,
      [row.phone, row.mark],
    );
    if (match !== undefined) {
      out.set(row.rowNo, { customerId: match.customer_id, customerName: match.display_name, trust: match.trust, matchedBy: match.matched_by, conflict: match.conflict });
    }
  }
  return out;
}

async function alreadyImported(q: Queryable, sha256: string): Promise<{ shipmentId: string; code: string } | null> {
  const row = await q.first<{ shipment_id: string | null; shipment_code: string | null }>(
    "select shipment_id, shipment_code from source_file_shipments where sha256 = $1",
    [sha256],
  );
  return row === undefined || row.shipment_id === null ? null : { shipmentId: row.shipment_id, code: row.shipment_code as string };
}

function mappingOf(given: Partial<Record<string, number>> | undefined, headers: string[]): ImportMapping {
  return given === undefined ? guessMapping(headers) : (given as ImportMapping);
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.post("/imports/preview", { bodyLimit: LIMIT, config: { access: "signed_in" } }, async (request): Promise<ImportPreview> => {
    const body = parse(ImportPreviewRequest, request.body);
    const { bytes, sheets } = readWorkbook(body.filename, body.content);
    const sheet = pick(sheets, body.sheet);
    const headerRow = body.headerRow ?? findHeaderRow(sheet.rows);
    const headers = (sheet.rows[headerRow] ?? []).map(text);
    const mapping = mappingOf(body.mapping, headers);
    const rows = readRows(sheet.rows, headerRow, mapping);
    if (rows.length > MAX_ROWS) throw new ApiError(422, "file_too_large", `A file can have at most ${MAX_ROWS} rows`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    return read(ctx, async (q) => {
      const matches = await matchRows(q, rows);
      const previewRows: ImportPreviewRow[] = rows.map((row) => ({ ...row, match: matches.get(row.rowNo) ?? null }));
      return {
        filename: body.filename,
        sha256,
        alreadyImported: await alreadyImported(q, sha256),
        sheets: sheets.map((s) => s.name),
        sheet: sheet.name,
        headerRow,
        top: sheet.rows.slice(0, 15).map((row) => row.map(text)),
        headers,
        mapping,
        suggestedCode: codeFromFilename(body.filename),
        rows: previewRows,
        totals: {
          rows: rows.length,
          matched: previewRows.filter((r) => r.match !== null).length,
          unmatched: previewRows.filter((r) => r.match === null).length,
          withProblems: previewRows.filter((r) => r.problems.length > 0).length,
          amountUsdCents: rows.reduce((sum, r) => sum + (r.amountUsdCents ?? 0), 0),
        },
      };
    });
  });

  app.post("/imports", { bodyLimit: LIMIT, config: { access: "signed_in" } }, async (request, reply): Promise<ShipmentDetail> => {
    const body = parse(ImportRequest, request.body);
    const { bytes, sheets } = readWorkbook(body.filename, body.content);
    const sheet = pick(sheets, body.sheet);
    const rows = readRows(sheet.rows, body.headerRow, body.mapping as ImportMapping);
    if (rows.length === 0) throw new ApiError(422, "import_empty", "There are no rows under the headings");
    if (rows.length > MAX_ROWS) throw new ApiError(422, "file_too_large", `A file can have at most ${MAX_ROWS} rows`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const decisions = new Map<number, ImportDecision>(body.decisions.map((d) => [d.rowNo, d]));

    return write(ctx, request, reply, async ({ q, auth }) => {
      const before = await alreadyImported(q, sha256);
      if (before !== null) throw new ApiError(409, "file_already_imported", `This spreadsheet was already imported as ${before.code}`);
      const matches = await matchRows(q, rows);

      // Each row is someone's, or left out. Every problem is said at once.
      const fields: Record<string, string> = {};
      const owner = new Map<number, string | { name: string; phone: string | null; mark: string | null }>();
      for (const row of rows) {
        const decision = decisions.get(row.rowNo);
        if (decision !== undefined && "skip" in decision) continue;
        if (row.problems.length > 0) {
          fields[`rows.${row.rowNo}`] = `Row ${row.rowNo}: ${row.problems.join("; ")}`;
          continue;
        }
        if (decision !== undefined && "customerId" in decision) owner.set(row.rowNo, decision.customerId);
        else if (decision !== undefined && "newCustomer" in decision) {
          const phone = decision.newCustomer.phone === undefined || decision.newCustomer.phone === "" ? null : normalizePhone(decision.newCustomer.phone);
          if (decision.newCustomer.phone !== undefined && decision.newCustomer.phone !== "" && phone === null) {
            fields[`rows.${row.rowNo}`] = `Row ${row.rowNo}: "${decision.newCustomer.phone}" is not a phone number`;
            continue;
          }
          const mark = decision.newCustomer.mark === undefined || decision.newCustomer.mark.trim() === "" ? null : normalizeMark(decision.newCustomer.mark);
          owner.set(row.rowNo, { name: decision.newCustomer.name, phone, mark });
        } else {
          const match = matches.get(row.rowNo);
          if (match === undefined) fields[`rows.${row.rowNo}`] = `Row ${row.rowNo}: say whose goods these are, make a new customer, or leave the row out`;
          else owner.set(row.rowNo, match.customerId);
        }
      }
      if (Object.keys(fields).length > 0) {
        const first = Object.values(fields)[0] as string;
        throw new ApiError(400, "import_rows_unresolved", Object.keys(fields).length === 1 ? first : `${first} (and ${Object.keys(fields).length - 1} more)`, { fields });
      }
      if (owner.size === 0) throw new ApiError(422, "import_empty", "Every row was left out");

      // New customers: the same name, phone and mark on several rows is one customer.
      const made = new Map<string, string>();
      for (const [rowNo, who] of owner) {
        if (typeof who === "string") continue;
        const key = `${who.name.toLowerCase()}|${who.phone ?? ""}|${who.mark ?? ""}`;
        let id = made.get(key);
        if (id === undefined) {
          id = await q.value<string>("insert into customers (display_name) values ($1) returning id", [who.name]);
          if (who.phone !== null) await q.query("insert into customer_phones (customer_id, phone, is_primary) values ($1, $2, true)", [id, who.phone]);
          if (who.mark !== null) await q.query("insert into customer_marks (customer_id, mark, match) values ($1, $2, 'exact')", [id, who.mark]);
          made.set(key, id);
        }
        owner.set(rowNo, id);
      }
      for (const id of new Set([...owner.values()] as string[])) {
        const exists = await q.first("select 1 from customers where id = $1 and merged_into is null", [id]);
        if (exists === undefined) throw new ApiError(400, "invalid_request", "One of the customers picked does not exist", { fields: { decisions: "There is no such customer" } });
      }

      const fileId = await q.value<string>(
        "insert into source_files (filename, storage_key, sha256, uploaded_by) values ($1, $2, $3, $4) returning id",
        [body.filename, `db:${sha256}`, sha256, auth.user.id],
      );
      await q.query("insert into source_file_contents (source_file_id, bytes) values ($1, $2)", [fileId, bytes]);
      const shipmentId = await q.value<string>("insert into shipments (code, arrived_on, source_file_id) values ($1, $2, $3) returning id", [
        body.code,
        body.arrivedOn ?? null,
        fileId,
      ]);

      // One consignment per customer: his rows added up, in the order they come.
      const byCustomer = new Map<string, ImportRow[]>();
      for (const row of rows) {
        const id = owner.get(row.rowNo);
        if (typeof id !== "string") continue;
        byCustomer.set(id, [...(byCustomer.get(id) ?? []), row]);
      }
      const consignmentOf = new Map<string, string>();
      for (const [customerId, own] of byCustomer) {
        const amount = own.reduce((sum, r) => sum + (r.amountUsdCents ?? 0), 0);
        const counted = own.filter((r) => r.cartons !== null);
        const cartons = counted.length === 0 ? null : counted.reduce((sum, r) => sum + (r.cartons ?? 0), 0);
        const city = own.find((r) => r.city !== null)?.city ?? null;
        const id = await q.value<string>(
          `insert into consignments (shipment_id, customer_id, amount_due_usd_cents, cartons_expected, city)
           values ($1, $2, $3, $4, $5) returning id`,
          [shipmentId, customerId, amount, cartons, city],
        );
        consignmentOf.set(customerId, id);
      }
      // Every row as the sheet had it, next to what was read from it.
      for (const row of rows) {
        const id = owner.get(row.rowNo);
        await q.query(
          `insert into shipment_lines (shipment_id, consignment_id, row_no, mark, cartons, weight_grams, goods_note, collect_usd_cents, city, note, raw)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [
            shipmentId,
            typeof id === "string" ? (consignmentOf.get(id) ?? null) : null,
            row.rowNo,
            row.mark,
            row.cartons,
            row.weightGrams,
            row.goods,
            row.amountUsdCents,
            row.city,
            typeof id === "string" ? null : "left out of the import",
            JSON.stringify(row.raw),
          ],
        );
      }
      return { status: 201, body: await shipmentDetail(q, shipmentId) };
    });
  });
}
