import { test } from "node:test";
import assert from "node:assert/strict";
import { codeFromFilename, findHeaderRow, guessField, guessMapping, readCount, readDollars, readKilograms, readRows } from "../src/index.ts";

test("headings are guessed in English, Chinese, Arabic and Kurdish", () => {
  assert.deepEqual(
    ["Shipping Mark", "唛头", "Tel", "电话", "ژمارە", "Customer", "收货人", "ناو", "Total USD", "应收金额", "CTNS", "件数", "G.W (KG)", "重量", "City", "شار", "Description", "品名"].map(guessField),
    ["mark", "mark", "phone", "phone", "phone", "name", "name", "name", "amount", "amount", "cartons", "cartons", "weight", "weight", "city", "city", "goods", "goods"],
  );
  // Short words stand alone, and a price per kilogram is neither weight nor amount.
  assert.equal(guessField("Hotel"), null);
  assert.equal(guessField("Price per KG"), null);
  assert.equal(guessField("单价"), null);
  assert.equal(guessField(""), null);
  assert.equal(guessField("Total weight"), "weight");
  assert.equal(guessField("Total CTNS"), "cartons");
});

test("each field goes to the first column that names it", () => {
  assert.deepEqual(guessMapping(["No.", "Mark", "Name", "Phone", "CTNS", "KG", "Collect $", "Mark 2"]), {
    mark: 1,
    name: 2,
    phone: 3,
    cartons: 4,
    weight: 5,
    amount: 6,
  });
});

test("the header row is found under a title and blank rows", () => {
  const rows = [["GREEN STAR CARGO", "", ""], [], ["File GSSK6926", "", ""], ["Mark", "Phone", "Total"], ["DARA", "0770 123 4567", "62"]];
  assert.equal(findHeaderRow(rows), 3);
  assert.equal(findHeaderRow([["a", "b"], ["1", "2"]]), 0);
});

test("dollars, cartons and kilograms are read the way a spreadsheet writes them", () => {
  assert.deepEqual([62, 62.5, "62", "$1,234.50", "1234.5", "USD 80", "80 $", 0.1 + 0.2].map(readDollars), [6200, 6250, 6200, 123450, 123450, 8000, 8000, 30]);
  assert.deepEqual(["62,5", "-5", -5, "abc", "", "1,23"].map(readDollars), [null, null, null, null, null, null]);
  assert.deepEqual([3, "3", "12 ctns", "2.5", -1].map(readCount), [3, 3, 12, null, null]);
  assert.deepEqual([12.5, "12.5", "1,200 kg", "x"].map(readKilograms), [12500, 12500, 1200000, null]);
});

test("rows are read with their problems; blank rows and the total line are left out", () => {
  const rows = [
    ["Mark", "Name", "Phone", "CTNS", "KG", "Collect", "City"],
    ["dara  m", "Dara Mhamad", "0770 123 4567", 3, 12.5, 62, "Sulaymaniyah"],
    [],
    ["", "", "", "", "", "", ""],
    ["YARO-OSMAN", "", "12345", "two", "", "abc", ""],
    ["", "Nobody", "", "", "", "", ""],
    ["", "", "", "", "", 75, ""],
    ["Total", "", "", 5, 30, 137, ""],
    ["合计", "", "", 5, 30, 137, ""],
  ];
  const read = readRows(rows, 0, guessMapping(rows[0] as string[]));
  assert.deepEqual(read.map((r) => r.rowNo), [2, 5, 6, 7]);
  const [dara, yaro, nobody, orphan] = read;
  assert.deepEqual(
    [dara?.mark, dara?.name, dara?.phone, dara?.cartons, dara?.weightGrams, dara?.amountUsdCents, dara?.city, dara?.problems],
    ["DARA M", "Dara Mhamad", "+9647701234567", 3, 12500, 6200, "Sulaymaniyah", []],
  );
  assert.deepEqual(dara?.raw, { Mark: "dara m", Name: "Dara Mhamad", Phone: "0770 123 4567", CTNS: "3", KG: "12.5", Collect: "62", City: "Sulaymaniyah" });
  assert.deepEqual(yaro?.problems, ['"12345" is not a phone number', '"abc" is not an amount in dollars', '"two" is not a number of cartons']);
  assert.deepEqual(nobody?.problems, ["No amount"]);
  assert.deepEqual(orphan?.problems, ["Nothing says whose goods these are"]);
  // Without an amount column, every row says so.
  assert.deepEqual(readRows(rows, 0, { mark: 0 })[0]?.problems, ["No column is the amount to collect"]);
});

test("a file code is taken from the file name when it has one", () => {
  assert.equal(codeFromFilename("GSSK6926 Sulaymaniyah.xlsx"), "GSSK6926");
  assert.equal(codeFromFilename("gssk-7001.xls"), "GSSK7001");
  assert.equal(codeFromFilename("customers.xlsx"), null);
});
