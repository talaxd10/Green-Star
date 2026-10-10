"use client";

import type { CustomerSummary, ImportFieldName, ImportPreview, ImportPreviewRow, ShipmentDetail } from "@green-star/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ChangeEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import { Button, Card, CardHead, Chip, Field, Input, LinkButton, Money, PageHead, Problem, Select, Table, Td, Th } from "@/components/ui";
import { api, ApiFailure } from "@/lib/api";
import { useSave } from "@/lib/hooks";
import { TRUST } from "@/lib/labels";

/** What each column can be, in the order the CEO reads them. */
const FIELDS: readonly { field: ImportFieldName; label: string; hint: string }[] = [
  { field: "mark", label: "Shipping mark", hint: "Finds the customer by his mark" },
  { field: "phone", label: "Phone", hint: "Finds the customer by his phone, before the mark" },
  { field: "name", label: "Customer name", hint: "For a new customer" },
  { field: "amount", label: "To collect, $", hint: "Required" },
  { field: "cartons", label: "Cartons", hint: "Added up per customer" },
  { field: "weight", label: "Weight, kg", hint: "Kept with the row" },
  { field: "city", label: "City", hint: "Where it goes" },
  { field: "goods", label: "Goods", hint: "Kept with the row" },
];

const MATCHED_BY: Record<string, string> = { phone: "by phone", mark: "by mark", mark_prefix: "by mark prefix" };

type Choice = { kind: "auto" } | { kind: "new"; name: string } | { kind: "pick"; customer: CustomerSummary | null } | { kind: "skip" };

const letter = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);

/** The choice a row starts with: its match, a new customer, or left out when the row has a problem. */
function startingChoice(row: ImportPreviewRow): Choice {
  if (row.problems.length > 0) return { kind: "skip" };
  if (row.match !== null) return { kind: "auto" };
  return { kind: "new", name: row.name ?? row.mark ?? row.phoneTyped ?? "" };
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export default function ImportPage() {
  const router = useRouter();
  const [source, setSource] = useState<{ filename: string; content: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [readProblem, setReadProblem] = useState<ApiFailure | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [code, setCode] = useState("");
  const [arrivedOn, setArrivedOn] = useState("");

  const make = useSave((body: unknown, key: string) => api.post<ShipmentDetail>("/v1/imports", body, key), (file) => router.push(`/files/${file.id}`));

  /** Reads the file again, the way it is asked. Nothing is saved. */
  const readAs = async (file: { filename: string; content: string }, how: { sheet?: string; headerRow?: number; mapping?: ImportPreview["mapping"] } = {}) => {
    setReading(true);
    setReadProblem(null);
    try {
      const next = await api.post<ImportPreview>("/v1/imports/preview", { ...file, ...how });
      setPreview(next);
      setChoices(Object.fromEntries(next.rows.map((row) => [row.rowNo, startingChoice(row)])));
      setCode((current) => (current === "" ? (next.suggestedCode ?? "") : current));
    } catch (error) {
      setReadProblem(error instanceof ApiFailure ? error : new ApiFailure(0, { code: "unknown", message: String(error) }));
    } finally {
      setReading(false);
    }
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    if (file.size > 10 * 1024 * 1024) {
      setReadProblem(new ApiFailure(413, { code: "file_too_large", message: "The file is larger than 10 MB" }));
      return;
    }
    const next = { filename: file.name, content: await base64(file) };
    setSource(next);
    setPreview(null);
    setCode("");
    make.clear();
    await readAs(next);
  };

  const rows = preview?.rows ?? [];
  const choiceOf = (row: ImportPreviewRow): Choice => choices[row.rowNo] ?? startingChoice(row);
  const setChoice = (rowNo: number, choice: Choice) => {
    setChoices((current) => ({ ...current, [rowNo]: choice }));
    make.clear();
  };

  const counts = useMemo(() => {
    const out = { going: 0, skipped: 0, newCustomers: new Set<string>(), unresolved: 0, amount: 0 };
    for (const row of rows) {
      const choice = choices[row.rowNo] ?? startingChoice(row);
      if (choice.kind === "skip") {
        out.skipped += 1;
        continue;
      }
      if (choice.kind === "new") {
        if (choice.name.trim() === "") out.unresolved += 1;
        else out.newCustomers.add(`${choice.name.trim().toLowerCase()}|${row.phone ?? ""}|${row.mark ?? ""}`);
      }
      if (choice.kind === "pick" && choice.customer === null) out.unresolved += 1;
      out.going += 1;
      out.amount += row.amountUsdCents ?? 0;
    }
    return out;
  }, [rows, choices]);

  const decisions = rows.flatMap((row): object[] => {
    const choice = choiceOf(row);
    if (choice.kind === "skip") return [{ rowNo: row.rowNo, skip: true }];
    if (choice.kind === "pick" && choice.customer !== null) return [{ rowNo: row.rowNo, customerId: choice.customer.id }];
    if (choice.kind === "new") {
      return [
        {
          rowNo: row.rowNo,
          newCustomer: { name: choice.name.trim(), ...(row.phone === null ? {} : { phone: row.phone }), ...(row.mark === null ? {} : { mark: row.mark }) },
        },
      ];
    }
    return [];
  });

  const mappingMissesAmount = preview !== null && preview.mapping.amount === undefined;
  const ready = source !== null && preview !== null && preview.alreadyImported === null && code.trim() !== "" && counts.going > 0 && counts.unresolved === 0 && !mappingMissesAmount;

  return (
    <>
      <PageHead
        eyebrow="Files"
        title="Import a file from Excel"
        hint="Any spreadsheet: .xlsx, .xls, .csv. Say which column is which, check who each row belongs to, and it becomes a draft file. Nothing is charged until you confirm it."
      >
        <LinkButton tone="quiet" href="/files">
          Cancel
        </LinkButton>
        <Button
          tone="primary"
          busy={make.saving}
          disabled={!ready}
          onClick={() =>
            void make.save({
              ...source,
              sheet: preview?.sheet,
              headerRow: preview?.headerRow,
              mapping: preview?.mapping,
              code: code.trim().toUpperCase(),
              ...(arrivedOn === "" ? {} : { arrivedOn }),
              decisions,
            })
          }
        >
          Make the draft file
        </Button>
      </PageHead>

      <Card className="mb-5 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="The spreadsheet" hint={source === null ? "From the China office, or your own list" : reading ? "Reading it…" : source.filename}>
            {(id) => <Input id={id} type="file" accept=".xlsx,.xls,.xlsm,.csv,.ods" onChange={(e) => void choose(e)} />}
          </Field>
          <Field label="File code" hint="As on the file: GSSK6926" problem={make.fieldProblem("code") ?? (make.problem?.code === "file_code_taken" ? make.problem.message : undefined)}>
            {(id) => <Input id={id} className="num uppercase" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Field label="Arrived on" hint="Optional">
            {(id) => <Input id={id} type="date" value={arrivedOn} onChange={(e) => setArrivedOn(e.target.value)} />}
          </Field>
        </div>
        <div className="mt-3">
          <Problem of={readProblem} />
        </div>
        {preview?.alreadyImported ? (
          <p className="mt-3 rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-ink" role="alert">
            This exact spreadsheet was already imported as{" "}
            <Link className="font-semibold underline" href={`/files/${preview.alreadyImported.shipmentId}`}>
              {preview.alreadyImported.code}
            </Link>
            . A file is never imported twice.
          </p>
        ) : null}
      </Card>

      {preview !== null && source !== null ? (
        <>
          <Card className="mb-5">
            <CardHead title="Which column is which" hint="Guessed from the headings. Change any guess and the rows are read again." />
            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
              {preview.sheets.length > 1 ? (
                <Field label="Sheet">
                  {(id) => (
                    <Select id={id} value={preview.sheet} onChange={(e) => void readAs(source, { sheet: e.target.value })}>
                      {preview.sheets.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              <Field label="Headings are on row" hint="The rows under it are read">
                {(id) => (
                  <Select id={id} value={preview.headerRow} onChange={(e) => void readAs(source, { sheet: preview.sheet, headerRow: Number(e.target.value) })}>
                    {preview.top.map((cells, index) => (
                      <option key={index} value={index}>
                        {index + 1}: {cells.filter((c) => c !== "").slice(0, 4).join(" · ") || "(empty)"}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {FIELDS.map(({ field, label, hint }) => (
                <Field key={field} label={label} hint={hint} problem={field === "amount" && mappingMissesAmount ? "Pick the column with the amount to collect" : undefined}>
                  {(id) => (
                    <Select
                      id={id}
                      value={preview.mapping[field] ?? ""}
                      onChange={(e) => {
                        const mapping = { ...preview.mapping };
                        if (e.target.value === "") delete mapping[field];
                        else mapping[field] = Number(e.target.value);
                        void readAs(source, { sheet: preview.sheet, headerRow: preview.headerRow, mapping });
                      }}
                    >
                      <option value="">Not in this sheet</option>
                      {preview.headers.map((heading, index) => (
                        <option key={index} value={index}>
                          {letter(index)}: {heading === "" ? "(no heading)" : heading}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead
              title="Rows"
              hint={
                <>
                  {preview.totals.rows} rows · {preview.totals.matched} found · {counts.newCustomers.size} new {counts.newCustomers.size === 1 ? "customer" : "customers"} · {counts.skipped} left out · to collect <Money amount={counts.amount} className="font-semibold text-ink" />
                </>
              }
            />
            {rows.length === 0 ? (
              <p className="p-5 text-sm text-muted">No rows under the headings. Pick the row the headings are on.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Row</Th>
                    <Th>Mark</Th>
                    <Th>Name</Th>
                    <Th>Phone</Th>
                    <Th right>Cartons</Th>
                    <Th right>To collect</Th>
                    <Th>Whose</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const choice = choiceOf(row);
                    const problem = make.fieldProblem(`rows.${row.rowNo}`);
                    return (
                      <tr key={row.rowNo} className={choice.kind === "skip" ? "text-faint" : undefined} data-row={row.rowNo}>
                        <Td className="num text-[13px] text-muted">{row.rowNo}</Td>
                        <Td className="num text-[13px]">{row.mark}</Td>
                        <Td>
                          <span dir="auto">{row.name}</span>
                        </Td>
                        <Td className="num text-[13px]">{row.phoneTyped}</Td>
                        <Td right className="num text-[13px]">{row.cartons}</Td>
                        <Td right>{row.amountUsdCents === null ? <span className="text-[13px] text-red">none</span> : <Money amount={row.amountUsdCents} />}</Td>
                        <Td className="min-w-[320px]">
                          {row.problems.length > 0 ? (
                            <p className="text-[13px] text-red">
                              {row.problems.join(". ")}. Fix it in the spreadsheet, or leave the row out.
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              <Select
                                aria-label={`Whose goods on row ${row.rowNo}`}
                                value={choice.kind}
                                onChange={(e) => {
                                  const kind = e.target.value as Choice["kind"];
                                  setChoice(row.rowNo, kind === "auto" ? { kind } : kind === "skip" ? { kind } : kind === "pick" ? { kind, customer: null } : { kind, name: row.name ?? row.mark ?? "" });
                                }}
                              >
                                {row.match !== null ? <option value="auto">{row.match.customerName}, found {MATCHED_BY[row.match.matchedBy] ?? ""}</option> : null}
                                <option value="new">A new customer</option>
                                <option value="pick">Someone else: pick him</option>
                                <option value="skip">Leave this row out</option>
                              </Select>
                              {choice.kind === "auto" && row.match !== null ? (
                                <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                                  <Chip tone={TRUST[row.match.trust].tone}>{TRUST[row.match.trust].label}</Chip>
                                  {row.match.conflict ? <span className="font-semibold text-amber-ink">The mark belongs to someone else. The phone wins unless you pick.</span> : null}
                                </span>
                              ) : null}
                              {choice.kind === "new" ? (
                                <Input aria-label={`New customer's name on row ${row.rowNo}`} value={choice.name} onChange={(e) => setChoice(row.rowNo, { kind: "new", name: e.target.value })} problem={choice.name.trim() === "" ? "Enter a name" : undefined} />
                              ) : null}
                              {choice.kind === "pick" ? <CustomerPicker id={`pick-${row.rowNo}`} value={choice.customer} onChange={(customer) => setChoice(row.rowNo, { kind: "pick", customer })} /> : null}
                            </div>
                          )}
                          {problem ? <p className="mt-1 text-[13px] text-red">{problem}</p> : null}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <div className="mt-4 max-w-xl">
            <Problem of={make.problem} />
          </div>
        </>
      ) : null}
    </>
  );
}
