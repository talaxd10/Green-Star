// The Excel import, over the real routes against a real Postgres: a
// spreadsheet in any layout becomes a draft file, each row with its customer.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { call } from "./helpers.ts";
import { seedUser, signIn, start } from "./helpers.ts";
import { Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "Sarkar");
const s = new Scene(h, await signIn(h, ceo));

/** A workbook as base64, from rows of cells. Several sheets when asked. */
function book(sheets: Record<string, unknown[][]>, type: "xlsx" | "xls" | "csv" = "xlsx"): string {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  const out = XLSX.write(wb, { type: "buffer", bookType: type === "xls" ? "biff8" : type }) as Buffer;
  return out.toString("base64");
}

let phoneN = 4_000_000;
const newPhone = () => `0770 ${String(++phoneN).slice(0, 3)} ${String(phoneN).slice(3)}`;

test("a spreadsheet is read, its columns guessed, and each row matched by phone or mark; nothing is saved", async () => {
  const phone = newPhone();
  const byPhone = await s.customer(unique("BY PHONE "), { phones: [phone] });
  const mark = unique("MK");
  const byMark = await s.customer(unique("BY MARK "), { marks: [{ mark, match: "exact" }] });
  const prefix = unique("YR");
  const agent = await s.customer(unique("AGENT "), { marks: [{ mark: prefix, match: "prefix" }] });

  const content = book({
    Notes: [["Nothing here"]],
    File: [
      ["GREEN STAR CARGO", "", "", "", "", ""],
      ["唛头 Mark", "Customer", "电话 Phone", "CTNS", "KG", "Collect USD"],
      ["", "Dara", phone, 3, 12.5, 62],
      [mark.toLowerCase(), "", "", 1, 4, "$1,200.50"],
      [`${prefix} OSMAN`, "Osman", "", 2, 7, 80],
      ["NOBODY", "Somebody New", "0750 999 8877", 1, 1, 10],
      ["BROKEN", "", "", "two", "", "abc"],
      ["Total", "", "", 9, 30, 1352.5],
    ],
  });
  const fileCode = `GSSK${100000 + Math.floor(Math.random() * 899999)}`;
  const filename = `${fileCode} sulaymaniyah.xlsx`;
  const reply = await s.send("POST", "/v1/imports/preview", { filename, content, sheet: "File" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const p = reply.body;
  assert.deepEqual(p.sheets, ["Notes", "File"]);
  assert.equal(p.sheet, "File");
  assert.equal(p.headerRow, 1, "the title row is skipped");
  assert.deepEqual(p.mapping, { mark: 0, name: 1, phone: 2, cartons: 3, weight: 4, amount: 5 });
  assert.equal(p.suggestedCode, fileCode);
  assert.equal(p.alreadyImported, null);
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.rows.map((r: { rowNo: number }) => r.rowNo), [3, 4, 5, 6, 7], "the total line is left out");
  const by = (rowNo: number) => p.rows.find((r: { rowNo: number }) => r.rowNo === rowNo);
  assert.deepEqual([by(3).match.customerId, by(3).match.matchedBy, by(3).amountUsdCents, by(3).weightGrams], [byPhone, "phone", 6_200, 12_500]);
  assert.deepEqual([by(4).match.customerId, by(4).match.matchedBy, by(4).amountUsdCents], [byMark, "mark", 120_050]);
  assert.deepEqual([by(5).match.customerId, by(5).match.matchedBy], [agent, "mark_prefix"]);
  assert.equal(by(6).match, null);
  assert.deepEqual(by(7).problems, ['"abc" is not an amount in dollars', '"two" is not a number of cartons']);
  assert.deepEqual(p.totals, { rows: 5, matched: 3, unmatched: 2, withProblems: 1, amountUsdCents: 6_200 + 120_050 + 8_000 + 1_000 });

  // A column read another way changes what is read.
  const other = await s.send("POST", "/v1/imports/preview", { filename, content, sheet: "File", headerRow: 1, mapping: { mark: 0, amount: 4 } });
  assert.equal(other.body.rows.find((r: { rowNo: number }) => r.rowNo === 3).amountUsdCents, 1_250);
  // The first sheet with rows is read when none is named.
  assert.equal((await s.send("POST", "/v1/imports/preview", { filename, content })).body.sheet, "Notes");

  // Nothing was saved.
  const files = await h.owner.query("select count(*)::int as n from source_files where filename = $1", [filename]);
  assert.equal(files.rows[0].n, 0);
});

test("the import makes a draft: one consignment per customer, rows kept as they were, new customers made, rows left out", async () => {
  const phone = newPhone();
  const known = await s.customer(unique("KNOWN "), { phones: [phone] });
  const picked = await s.customer(unique("PICKED "));
  const newMark = unique("NEW");
  const code = unique("GSSK");
  const content = book({
    Sheet1: [
      ["Mark", "Name", "Phone", "Cartons", "Total", "City"],
      ["", "Known", phone, 2, 50, "Erbil"],
      ["", "Known again", phone, 1, 25.5, ""],
      ["UNKNOWN 1", "Hawre", "", 1, 30, ""],
      [newMark, "Kawa New", "0751 222 3344", 3, 40, ""],
      [newMark, "Kawa New", "0751 222 3344", 1, 5, ""],
      ["JUNK", "", "", "", "oops", ""],
    ],
  });
  const filename = `${code}.xlsx`;
  const base = { filename, content, sheet: "Sheet1", headerRow: 0, mapping: { mark: 0, name: 1, phone: 2, cartons: 3, amount: 4, city: 5 }, code, arrivedOn: "2026-10-09" };

  // Rows nobody can be matched to, and a row with a problem, are each named.
  const unresolved = await s.send("POST", "/v1/imports", base);
  assert.equal(unresolved.status, 400);
  assert.equal(unresolved.body.code, "import_rows_unresolved");
  assert.deepEqual(Object.keys(unresolved.body.fields).sort(), ["rows.4", "rows.5", "rows.6", "rows.7"]);
  assert.match(unresolved.body.fields["rows.7"], /"oops" is not an amount/);

  const made = await s.send("POST", "/v1/imports", {
    ...base,
    decisions: [
      { rowNo: 4, customerId: picked },
      { rowNo: 5, newCustomer: { name: "Kawa New", phone: "0751 222 3344", mark: newMark } },
      { rowNo: 6, newCustomer: { name: "Kawa New", phone: "0751 222 3344", mark: newMark } },
      { rowNo: 7, skip: true },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const f = made.body;
  assert.deepEqual([f.code, f.status, f.arrivedOn, f.consignments, f.expectedUsdCents], [code, "draft", "2026-10-09", 3, 0]);
  assert.deepEqual(f.sourceFile, { filename, rows: 6, leftOut: 1 });
  const row = (customerId: string) => f.consignmentList.find((c: { customerId: string }) => c.customerId === customerId);
  assert.deepEqual([row(known).amountDueUsdCents, row(known).cartonsExpected, row(known).city], [7_550, 3, "Erbil"], "his two rows add up");
  assert.equal(row(picked).amountDueUsdCents, 3_000);
  const kawa = f.consignmentList.find((c: { customerName: string }) => c.customerName === "Kawa New");
  assert.deepEqual([kawa.amountDueUsdCents, kawa.cartonsExpected], [4_500, 4]);
  // The new customer has his phone and mark, so the next file finds him by himself.
  const detail = (await s.get(`/v1/customers/${kawa.customerId}`)).body;
  assert.deepEqual([detail.phoneList.map((p: { phone: string }) => p.phone), detail.markList.map((m: { mark: string }) => m.mark)], [["+9647512223344"], [newMark]]);

  // Every row is kept as the sheet had it.
  const lines = await h.owner.query("select row_no, consignment_id, collect_usd_cents, raw ->> 'Name' as name, note from shipment_lines where shipment_id = $1 order by row_no", [f.id]);
  assert.deepEqual(lines.rows.map((l) => [l.row_no, l.consignment_id === null, Number(l.collect_usd_cents ?? 0), l.name, l.note]), [
    [2, false, 5_000, "Known", null],
    [3, false, 2_550, "Known again", null],
    [4, false, 3_000, "Hawre", null],
    [5, false, 4_000, "Kawa New", null],
    [6, false, 500, "Kawa New", null],
    [7, true, 0, null, "left out of the import"],
  ]);
  const stored = await h.owner.query("select encode(sha256(c.bytes), 'hex') = f.sha256 as same from source_files f join source_file_contents c on c.source_file_id = f.id join shipments s on s.source_file_id = f.id where s.id = $1", [f.id]);
  assert.equal(stored.rows[0].same, true, "the file itself is kept");

  // The same spreadsheet again is refused, and the preview says where it went.
  const again = await s.send("POST", "/v1/imports", { ...base, code: unique("GSSK"), decisions: [{ rowNo: 4, skip: true }, { rowNo: 5, skip: true }, { rowNo: 6, skip: true }, { rowNo: 7, skip: true }] });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "file_already_imported");
  assert.match(again.body.message, new RegExp(code));
  assert.deepEqual((await s.send("POST", "/v1/imports/preview", { filename, content })).body.alreadyImported, { shipmentId: f.id, code });

  // It is a draft like any other: rows can change, the sheet's rows stay with their customers, and confirming charges.
  const edited = await s.send("PUT", `/v1/shipments/${f.id}`, {
    code,
    consignments: f.consignmentList.map((c: { customerId: string; amountDueUsdCents: number }) => ({ customerId: c.customerId, amountDueUsdCents: c.customerId === known ? 8_000 : c.amountDueUsdCents })),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const relinked = await h.owner.query("select count(*)::int as n from shipment_lines where shipment_id = $1 and consignment_id is not null", [f.id]);
  assert.equal(relinked.rows[0].n, 5);
  assert.equal((await s.send("POST", `/v1/shipments/${f.id}/confirm`, {})).status, 200);
  assert.equal(await s.balance(known), 8_000);
  await s.sound();
});

test("old .xls and .csv files are read too; something that is not a spreadsheet is refused", async () => {
  const rows = [["Mark", "Amount"], ["A1", 10], ["B2", 20.25]];
  for (const type of ["xls", "csv"] as const) {
    const reply = await s.send("POST", "/v1/imports/preview", { filename: `old.${type}`, content: book({ S: rows }, type) });
    assert.equal(reply.status, 200, `${type}: ${JSON.stringify(reply.body)}`);
    assert.deepEqual(reply.body.rows.map((r: { amountUsdCents: number }) => r.amountUsdCents), [1_000, 2_025], type);
  }
  const junk = await s.send("POST", "/v1/imports/preview", { filename: "photo.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]).toString("base64") });
  assert.ok([200, 422].includes(junk.status));
  if (junk.status === 200) assert.equal(junk.body.rows.length, 0, "nothing readable comes out of it");
  assert.equal((await s.send("POST", "/v1/imports/preview", { filename: "x.xlsx", content: "" })).status, 400);
});

test("only the CEO, signed in, can read or import a file", async () => {
  const content = book({ S: [["Mark", "Amount"], ["A1", 10]] });
  assert.equal((await call(h.app, "POST", "/v1/imports/preview", { body: { filename: "a.xlsx", content } })).status, 401);
  assert.equal((await call(h.app, "POST", "/v1/imports", { body: { filename: "a.xlsx", content, sheet: "S", headerRow: 0, mapping: {}, code: "X1" }, key: randomUUID() })).status, 401);
});
