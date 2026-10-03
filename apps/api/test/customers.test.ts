// Customers, over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, nextPhone, seedUser, signIn, start } from "./helpers.ts";
import { Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const owner = await seedUser(h, "owner");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, owner);

test("a customer is created with his phones and marks, stored the way the files will match them", async () => {
  const phone = nextPhone();
  const second = nextPhone();
  const mark = unique("hemn s");
  const made = await s.send("POST", "/v1/customers", {
    name: "  Hemn Salih ",
    phones: [`0${phone.slice(4, 7)} ${phone.slice(7, 10)} ${phone.slice(10)}`, second],
    marks: [{ mark: `  ${mark.toLowerCase()}  ` }],
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.name, "Hemn Salih");
  assert.equal(made.body.kind, "person");
  assert.equal(made.body.trust, "pay_first", "a new customer pays first");
  assert.equal(made.body.creditLimitUsdCents, null);
  assert.equal(made.body.balanceUsdCents, 0);
  assert.equal(made.body.phone, phone, "the first phone is his main one, in international form");
  assert.deepEqual(made.body.phoneList.map((p: { phone: string; primary: boolean }) => [p.phone, p.primary]), [[phone, true], [second, false]]);
  assert.deepEqual(made.body.markList.map((m: { mark: string; match: string }) => [m.mark, m.match]), [[mark, "exact"]]);

  const read = await s.get(`/v1/customers/${made.body.id}`);
  assert.deepEqual(read.body, made.body);
  assert.deepEqual((await s.get(`/v1/customers/${made.body.id}`, ownerCookie)).body, made.body, "the owner sees the same");
});

test("he is found by phone in any spelling, by mark, by a mark prefix, and by any part of his name", async () => {
  const word = unique("ZX");
  const phone = nextPhone();
  const mark = unique("MARK");
  const prefix = unique("YARO");
  const person = await s.customer(`Rebwar ${word} Ali`, { phones: [phone], marks: [{ mark }] });
  const agent = await s.customer(`Agent ${word}`, { marks: [{ mark: prefix, match: "prefix" }] });

  const find = async (q: string) => (await s.get(`/v1/customers?q=${encodeURIComponent(q)}`)).body.items.map((c: { id: string }) => c.id);
  assert.deepEqual((await find(word.toLowerCase())).sort(), [person, agent].sort(), "part of a name, any case");
  assert.deepEqual(await find(phone), [person]);
  assert.deepEqual(await find(`0${phone.slice(4, 7)} ${phone.slice(7, 10)} ${phone.slice(10)}`), [person], "the phone as he would say it");
  assert.deepEqual(await find(phone.slice(-7)), [person], "the last digits of a phone");
  assert.deepEqual(await find(mark.toLowerCase()), [person]);
  assert.deepEqual(await find(`${prefix} MHAMAD`), [agent], "a file's mark that starts with an agent's prefix");
  assert.deepEqual(await find(unique("NOBODY")), []);
  // A search is words, not a pattern: % and _ find only names that contain them.
  assert.deepEqual(await find("%"), []);
  assert.deepEqual(await find("_"), []);
  assert.deepEqual(await find(`${word.slice(0, 3)}%${word.slice(-2)}`), []);
});

test("what is typed is checked, and a refused customer leaves nothing behind", async () => {
  const name = unique("Refused ");
  const taken = nextPhone();
  const takenMark = unique("TAKEN");
  await s.customer(unique("Holder "), { phones: [taken], marks: [{ mark: takenMark }] });

  const cases: [Record<string, unknown>, number, string][] = [
    [{ name, phones: ["12345"] }, 400, "invalid_request"],
    [{ name: "  " }, 400, "invalid_request"],
    [{ name, kind: "company" }, 400, "invalid_request"],
    [{ name, marks: [{ mark: "   " }] }, 400, "invalid_request"],
    [{ name, trust: "trusted" }, 400, "invalid_request"],
    [{ name, phones: [nextPhone(), taken] }, 409, "customer_phone_taken"],
    [{ name, marks: [{ mark: takenMark.toLowerCase() }] }, 409, "mark_taken"],
  ];
  for (const [body, status, code] of cases) {
    const reply = await s.send("POST", "/v1/customers", body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.equal(reply.body.code, code, JSON.stringify(reply.body));
  }
  assert.equal((await s.send("POST", "/v1/customers", { name, phones: ["12345"] })).body.fields["phones.0"], "That is not a phone number");
  assert.deepEqual((await s.get(`/v1/customers?q=${encodeURIComponent(name)}`)).body.items, []);
});

test("trust and limit change with who asked, and every change is kept", async () => {
  const id = await s.customer();
  const noAsker = await s.send("PATCH", `/v1/customers/${id}`, { trust: { trust: "trusted", creditLimitUsdCents: 50_000 } });
  assert.equal(noAsker.status, 400);
  assert.ok("trust.askedBy" in noAsker.body.fields);

  const trusted = await s.send("PATCH", `/v1/customers/${id}`, {
    trust: { trust: "trusted", creditLimitUsdCents: 50_000, askedBy: "China office", note: "Ships every week" },
  });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.trust, "trusted");
  assert.equal(trusted.body.creditLimitUsdCents, 50_000);

  // Back to pay first: the limit goes with it, whatever was sent.
  const back = await s.send("PATCH", `/v1/customers/${id}`, { trust: { trust: "pay_first", creditLimitUsdCents: 99_000, askedBy: "China office" } });
  assert.equal(back.body.trust, "pay_first");
  assert.equal(back.body.creditLimitUsdCents, null);

  assert.deepEqual(
    back.body.trustChanges.map((c: Record<string, unknown>) => [c.trustBefore, c.trustAfter, c.limitBeforeUsdCents, c.limitAfterUsdCents, c.askedBy, c.note, c.changedBy]),
    [
      ["trusted", "pay_first", 50_000, null, "China office", null, "Sarkar"],
      ["pay_first", "trusted", null, 50_000, "China office", "Ships every week", "Sarkar"],
    ],
  );
});

test("the list can show only trusted customers, those over their limit, and those who owe", async () => {
  const word = unique("FILTER");
  const quiet = await s.customer(`${word} quiet`);
  const owes = await s.customer(`${word} owes`);
  const trusted = await s.customer(`${word} trusted`, { trusted: true, limitUsdCents: 100_000 });
  const over = await s.customer(`${word} over`, { trusted: true, limitUsdCents: 10_000 });
  await s.file([[owes, 4_000], [trusted, 30_000], [over, 25_000]]);

  const list = async (extra: string) =>
    (await s.get(`/v1/customers?q=${word}${extra}`)).body.items.map((c: { id: string }) => c.id).sort();
  assert.deepEqual(await list(""), [quiet, owes, trusted, over].sort());
  assert.deepEqual(await list("&trust=trusted"), [trusted, over].sort());
  assert.deepEqual(await list("&trust=pay_first"), [quiet, owes].sort());
  assert.deepEqual(await list("&filter=owing"), [owes, trusted, over].sort());
  assert.deepEqual(await list("&filter=over_limit"), [over]);

  const row = (await s.get(`/v1/customers?q=${word}&filter=over_limit`)).body.items[0];
  assert.equal(row.balanceUsdCents, 25_000);
  assert.equal(row.creditLimitUsdCents, 10_000);
  assert.equal(row.overLimit, true);
  assert.equal(row.unpaidConsignments, 1);
  assert.equal((await s.get("/v1/customers?trust=sometimes")).status, 400);
});

test("a list comes a page at a time, newest first, with nothing twice and nothing missed", async () => {
  const word = unique("PAGE");
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) ids.push(await s.customer(`${word} ${i}`));

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string = `/v1/customers?q=${word}&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
    const page = (await s.get(url)).body;
    assert.ok(page.items.length <= 2);
    seen.push(...page.items.map((c: { id: string }) => c.id));
    cursor = page.nextCursor;
    pages += 1;
    // A customer added while someone is paging does not shift the pages.
    if (pages === 1) await s.customer(`${word} late`);
  } while (cursor !== null);

  assert.equal(pages, 3);
  assert.deepEqual(seen, [...ids].reverse(), "newest first, each one once");
  assert.equal((await s.get("/v1/customers?cursor=not-a-cursor")).status, 400);
  assert.equal((await s.get("/v1/customers?limit=0")).status, 400);
  assert.equal((await s.get("/v1/customers?limit=500")).status, 400);
});

test("phones and marks are added and removed, and one phone is the main one", async () => {
  const id = await s.customer(undefined, { phones: [] });
  const first = nextPhone();
  const second = nextPhone();
  assert.equal((await s.send("POST", `/v1/customers/${id}/phones`, { phone: first })).status, 201);
  const withTwo = await s.send("POST", `/v1/customers/${id}/phones`, { phone: second, primary: true });
  assert.equal(withTwo.body.phone, second, "the new main phone takes over");
  assert.equal(withTwo.body.phoneList.filter((p: { primary: boolean }) => p.primary).length, 1);

  assert.equal((await s.send("POST", `/v1/customers/${id}/phones`, { phone: second })).body.code, "customer_phone_taken");
  assert.equal((await s.send("POST", `/v1/customers/${id}/phones`, { phone: "nope" })).status, 400);

  const mark = unique("NEW");
  const marked = await s.send("POST", `/v1/customers/${id}/marks`, { mark, match: "prefix" });
  assert.deepEqual(marked.body.markList.map((m: { mark: string; match: string }) => [m.mark, m.match]), [[mark, "prefix"]]);

  const phoneId = withTwo.body.phoneList.find((p: { phone: string }) => p.phone === first).id;
  const removed = await s.send("DELETE", `/v1/customers/${id}/phones/${phoneId}`);
  assert.deepEqual(removed.body.phones, [second]);
  assert.equal((await s.send("DELETE", `/v1/customers/${id}/phones/${phoneId}`)).status, 404);
  const unmarked = await s.send("DELETE", `/v1/customers/${id}/marks/${marked.body.markList[0].id}`);
  assert.deepEqual(unmarked.body.marks, []);

  // Another customer's phone cannot be removed through this one.
  const other = await s.customer();
  const otherPhone = (await s.get(`/v1/customers/${other}`)).body.phoneList[0].id;
  assert.equal((await s.send("DELETE", `/v1/customers/${id}/phones/${otherPhone}`)).status, 404);
  assert.equal((await s.get(`/v1/customers/${other}`)).body.phoneList.length, 1);
});

test("a duplicate is merged into the real customer, and says where it went", async () => {
  const realPhone = nextPhone();
  const dupPhone = nextPhone();
  const real = await s.customer("Dara M.", { phones: [realPhone] });
  const dup = await s.customer("DARA MHAMAD", { phones: [dupPhone] });
  const draft = await s.draft([[dup, 7_000]]);

  const merged = await s.send("POST", `/v1/customers/${real}/merge`, { duplicateId: dup });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body.phones, [realPhone, dupPhone]);
  assert.deepEqual(merged.body.aliases, ["DARA MHAMAD"], "his name as the duplicate had it is kept");

  const gone = await s.get(`/v1/customers/${dup}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, "customer_merged");
  assert.equal(gone.body.fields.mergedInto, real);
  assert.deepEqual((await s.get(`/v1/customers?q=${dupPhone}`)).body.items.map((c: { id: string }) => c.id), [real]);
  assert.equal((await s.get(`/v1/shipments/${draft.id}`)).body.consignmentList[0].customerId, real, "his row on the draft file moved too");

  // One with goods or money on the books is not merged away.
  const charged = await s.customer();
  await s.file([[charged, 3_000]]);
  const refused = await s.send("POST", `/v1/customers/${real}/merge`, { duplicateId: charged });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "merge_has_history");
  assert.equal((await s.send("POST", `/v1/customers/${real}/merge`, { duplicateId: real })).body.code, "merge_invalid");
  assert.equal((await s.send("POST", `/v1/customers/${real}/merge`, { duplicateId: randomUUID() })).status, 404);
  assert.equal((await s.send("PATCH", `/v1/customers/${dup}`, { name: "Back again" })).status, 404, "a merged customer is not changed");
});

test("the owner reads customers and changes none", async () => {
  const id = await s.customer();
  assert.equal((await s.get("/v1/customers?limit=1", ownerCookie)).status, 200);
  const tries: [string, string, unknown][] = [
    ["POST", "/v1/customers", { name: "By the owner" }],
    ["PATCH", `/v1/customers/${id}`, { name: "Renamed by the owner" }],
    ["PATCH", `/v1/customers/${id}`, { trust: { trust: "trusted", askedBy: "me" } }],
    ["POST", `/v1/customers/${id}/phones`, { phone: nextPhone() }],
    ["POST", `/v1/customers/${id}/marks`, { mark: unique("OWNER") }],
    ["POST", `/v1/customers/${id}/merge`, { duplicateId: randomUUID() }],
  ];
  for (const [method, url, body] of tries) {
    const reply = await call(h.app, method, url, { cookie: ownerCookie, body });
    assert.equal(reply.status, 403, `${method} ${url}`);
    assert.equal(reply.body.code, "not_allowed");
  }
  assert.equal((await s.get(`/v1/customers/${id}`)).body.trust, "pay_first");
});

test("every change to a customer is in the audit log under the CEO's name", async () => {
  const id = await s.customer("Audited");
  await s.send("PATCH", `/v1/customers/${id}`, { name: "Audited twice" });
  const { rows } = await h.owner.query(
    "select action, actor, before ->> 'display_name' as before, after ->> 'display_name' as after from audit_log where entity = 'customers' and entity_id = $1 order by id",
    [id],
  );
  assert.deepEqual(rows, [
    { action: "insert", actor: ceo.id, before: null, after: "Audited" },
    { action: "update", actor: ceo.id, before: "Audited", after: "Audited twice" },
  ]);
});
