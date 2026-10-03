// A statement as the customer sees it: a short text to paste into a message,
// and a page that is drawn into an image and a PDF.
//
// Both are made from the same Statement the screen shows, so the three can
// never say different amounts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PaymentMethod, Statement, StatementLine } from "@green-star/contracts";
import { format, money } from "@green-star/domain";

const usd = (cents: number) => format(money(Math.abs(cents), "USD"));

const BAGHDAD = "Asia/Baghdad";
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, hour: "2-digit", minute: "2-digit", hour12: false });

/** "3 Oct 2026", from a Baghdad day or an instant. */
export function dayText(value: string): string {
  return dayFormat.format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+03:00` : value));
}

const METHOD: Record<PaymentMethod, string> = {
  driver_cash: "cash to the driver",
  office_cash: "cash at the office",
  fib: "FIB",
  fastpay: "FastPay",
  zaincash: "ZainCash",
};

/** "You owe $470.00." in the three ways an account can stand. */
export function balanceSentence(balanceUsdCents: number): string {
  if (balanceUsdCents > 0) return `You owe ${usd(balanceUsdCents)}.`;
  if (balanceUsdCents < 0) return `You are ${usd(balanceUsdCents)} in credit.`;
  return "You owe nothing. Thank you.";
}

/** What a line was, in a few words: "File GSSK6926", "Paid by FIB". */
export function lineText(line: StatementLine): string {
  const what =
    line.kind === "charge"
      ? `File ${line.shipmentCode ?? ""}`.trim()
      : line.method === null
        ? "Payment"
        : line.method === "driver_cash" || line.method === "office_cash"
          ? `Paid in ${METHOD[line.method]}`
          : `Paid by ${METHOD[line.method]}`;
  return line.isReversal ? `${what}, taken back` : what;
}

/** For a dinar payment: "123,500 IQD at 1,450". */
export function dinarText(line: StatementLine): string | null {
  if (line.receivedCurrency !== "IQD" || line.receivedAmount === null || line.iqdPer100Usd === null) return null;
  const perDollar = line.iqdPer100Usd / 100;
  const rate = Number.isInteger(perDollar) ? format(money(perDollar, "IQD")).replace(" IQD", "") : perDollar.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${format(money(line.receivedAmount, "IQD"))} at ${rate}`;
}

/**
 * The text the CEO pastes into a message. Short on purpose: what he owes,
 * which files it is for, and the last payment received.
 */
export function statementText(s: Statement): string {
  const out: string[] = ["Green Star", `Statement for ${s.customerName}, ${dayText(s.asOf)}`, "", balanceSentence(s.balanceUsdCents)];
  if (s.open.length > 0) {
    out.push("", "Not paid in full:");
    for (const file of s.open) {
      const day = file.day === null ? "" : `, ${dayText(file.day)}`;
      const paid = file.paidUsdCents > 0 ? `, paid ${usd(file.paidUsdCents)}` : "";
      out.push(`- ${file.shipmentCode}${day}: ${usd(file.dueUsdCents)}${paid}, left ${usd(file.remainingUsdCents)}`);
    }
  }
  if (s.lastPayment !== null) {
    out.push("", `Last payment received: ${usd(s.lastPayment.amountUsdCents)} on ${dayText(s.lastPayment.day)}.`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The page that is drawn
// ---------------------------------------------------------------------------

/** Names and notes are typed by people. Nothing typed is ever read as markup. */
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const FONTS: readonly { family: string; weight: string; stretch?: string; file: string }[] = [
  { family: "Archivo", weight: "100 900", stretch: "62% 125%", file: "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2" },
  { family: "IBM Plex Mono", weight: "400", file: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2" },
  { family: "IBM Plex Mono", weight: "600", file: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2" },
  // Kurdish and Arabic names. Without this they would be drawn with whatever the server happens to have, or as empty boxes.
  { family: "Noto Sans Arabic", weight: "400", file: "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff2" },
  { family: "Noto Sans Arabic", weight: "700", file: "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2" },
];

let fontCss: string | null = null;

/** The fonts, inside the page itself, so drawing it never reaches out to the network. */
function fonts(): string {
  fontCss ??= FONTS.map((font) => {
    const data = readFileSync(fileURLToPath(import.meta.resolve(font.file))).toString("base64");
    return `@font-face{font-family:"${font.family}";font-weight:${font.weight};${font.stretch ? `font-stretch:${font.stretch};` : ""}font-style:normal;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  }).join("\n");
  return fontCss;
}

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{width:760px;background:#fff;color:#14201a;font-family:"Archivo","Noto Sans Arabic",sans-serif;font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
.page{padding:36px 40px 30px}
.num{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.top{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:2px solid #14201a}
.brand{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:780;font-stretch:76%;line-height:1}
.doc{text-align:right}
.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6a61}
.doc .date{font-size:15px;font-weight:600;margin-top:2px}
.who{margin-top:22px}
.who .name{font-size:28px;font-weight:760;font-stretch:80%;line-height:1.15}
.who .phone{color:#5a6a61;margin-top:2px}
.owe{margin-top:18px;border-radius:12px;padding:18px 22px;display:flex;justify-content:space-between;align-items:flex-end;gap:20px}
.owe.due{background:#fbefd3;color:#7a4e00}
.owe.clear{background:#dff0e6;color:#1d6b45}
.owe .label{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.09em;text-transform:uppercase}
.owe .amount{font-family:"IBM Plex Mono",monospace;font-size:40px;font-weight:600;line-height:1.05;letter-spacing:-.02em;margin-top:4px}
.owe .asof{font-size:13px;text-align:right}
h2{font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#5a6a61;margin:26px 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:400;letter-spacing:.08em;text-transform:uppercase;color:#5a6a61;text-align:left;padding:7px 8px;border-bottom:1px solid #a3b0a8}
td{padding:8px;border-bottom:1px solid #d6dcd6;vertical-align:top}
th.r,td.r{text-align:right;white-space:nowrap}
td.d{white-space:nowrap;color:#5a6a61}
td .sub{display:block;font-size:12px;color:#5a6a61}
tr.before td{color:#5a6a61;font-style:italic}
tr.last td{border-bottom:2px solid #14201a}
tr.last td:last-child{font-weight:600}
.foot{margin-top:22px;font-size:12px;color:#5a6a61;display:flex;justify-content:space-between;gap:24px}
@page{size:A4;margin:14mm 12mm}
@media print{body{width:auto}.page{padding:0}tr{break-inside:avoid}}
`;

const STAR = `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l2.9 6.6 7.2.7-5.4 4.8 1.6 7-6.3-3.7-6.3 3.7 1.6-7L1.9 9.1l7.2-.7z" fill="#1d6b45"/></svg>`;

const cell = (cents: number) => `<td class="r num">${usd(cents)}</td>`;
const emptyCell = `<td class="r"></td>`;
/** A balance in a column: what he owes as it is, credit with a minus. */
const balanceCell = (cents: number) => `<td class="r num">${cents < 0 ? "-" : ""}${usd(cents)}</td>`;

/** The whole page, as one piece of HTML with nothing to fetch. */
export function statementHtml(s: Statement): string {
  const e = escapeHtml;
  const owes = s.balanceUsdCents > 0;
  const label = owes ? "You owe" : s.balanceUsdCents < 0 ? "In credit" : "Nothing to pay";

  const open =
    s.open.length === 0
      ? ""
      : `<h2>Not paid in full</h2>
<table>
<thead><tr><th>File</th><th>Date</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Left to pay</th></tr></thead>
<tbody>
${s.open
  .map(
    (file) =>
      `<tr><td class="num">${e(file.shipmentCode)}</td><td class="d">${file.day === null ? "" : dayText(file.day)}</td>${cell(file.dueUsdCents)}${cell(file.paidUsdCents)}${cell(file.remainingUsdCents)}</tr>`,
  )
  .join("\n")}
</tbody>
</table>`;

  const before =
    s.from !== null || s.openingBalanceUsdCents !== 0
      ? `<tr class="before"><td class="d"></td><td>Balance before${s.from === null ? "" : ` ${dayText(s.from)}`}</td>${emptyCell}${emptyCell}${balanceCell(s.openingBalanceUsdCents)}</tr>\n`
      : "";
  const rows = s.lines
    .map((line, index) => {
      const dinars = dinarText(line);
      const what = `${e(lineText(line))}${dinars === null ? "" : `<span class="sub num">${dinars}</span>`}`;
      const charge = line.changeUsdCents > 0 ? cell(line.changeUsdCents) : emptyCell;
      const payment = line.changeUsdCents < 0 ? cell(line.changeUsdCents) : emptyCell;
      return `<tr${index === s.lines.length - 1 ? ' class="last"' : ""}><td class="d">${dayText(line.day)}</td><td>${what}</td>${charge}${payment}${balanceCell(line.balanceAfterUsdCents)}</tr>`;
    })
    .join("\n");
  const account =
    s.lines.length === 0 && before === ""
      ? ""
      : `<h2>Your account</h2>
<table>
<thead><tr><th>Date</th><th>What</th><th class="r">Charged</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead>
<tbody>
${before}${rows}
</tbody>
</table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Statement for ${e(s.customerName)}</title>
<style>
${fonts()}
${CSS}
</style>
</head>
<body>
<div class="page">
<div class="top">
<div class="brand">${STAR}<span>Green Star</span></div>
<div class="doc"><div class="eyebrow">Statement</div><div class="date">${dayText(s.asOf)}</div></div>
</div>
<div class="who">
<div class="name" dir="auto">${e(s.customerName)}</div>
${s.phone === null ? "" : `<div class="phone num">${e(localPhone(s.phone))}</div>`}
</div>
<div class="owe ${owes ? "due" : "clear"}">
<div><div class="label">${label}</div><div class="amount">${usd(s.balanceUsdCents)}</div></div>
<div class="asof">As of ${dayText(s.asOf)}, ${timeFormat.format(new Date(s.asOf))}</div>
</div>
${open}
${account}
<div class="foot"><span>All amounts are in US dollars. Dinars are counted at the rate of the day they were paid.</span><span class="num">Green&nbsp;Star</span></div>
</div>
</body>
</html>`;
}

/** A phone number the way it is dialled in Iraq: +9647701234567 reads 0770 123 4567. */
function localPhone(value: string): string {
  const local = /^\+964(\d{3})(\d{3})(\d{4})$/.exec(value);
  return local ? `0${local[1]} ${local[2]} ${local[3]}` : value;
}
