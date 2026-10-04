// A day at the office, in a real browser: a file arrives, a round goes out and
// comes back, the cash is counted, a customer pays, the vault is closed.
// Each step starts where the one before it ended.

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "office password 1";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

async function signIn(phone: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Picks a customer in a "Phone, mark or name" box. */
async function pick(box: ReturnType<Page["getByRole"]>, typed: string, name: string) {
  await box.fill(typed);
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

test("a wrong password is refused, the right one opens the office", async () => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fcustomers/);

  await signIn("0770 000 0001", "not the password");
  await expect(page.getByText("Wrong phone number or password")).toBeVisible();

  await signIn("0770 000 0001", PASSWORD);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByText("Today's rate is not set")).toBeVisible();

  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await expect(page.getByText("No customers yet")).toBeVisible();
});

test("customers are added, and one is made trusted on the China office's word", async () => {
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name").fill("Rebwar A.");
  await page.getByLabel("Phone").fill("0750 111 2001");
  await page.getByLabel("Shipping mark").fill("rebwar ali");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Rebwar A." })).toBeVisible();
  await expect(page.getByText("0750 111 2001")).toBeVisible();
  await expect(page.getByText("REBWAR ALI")).toBeVisible();

  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name").fill("Dara M.");
  await page.getByLabel("Phone").fill("12345");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByText("That is not a phone number")).toBeVisible();
  await page.getByLabel("Phone").fill("0770 111 2003");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Dara M." })).toBeVisible();

  await page.getByRole("button", { name: "Trust and limit" }).click();
  await page.getByLabel("This customer").selectOption("trusted");
  await page.getByLabel("His limit, in dollars").fill("5,000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Trusted", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("asked by China office")).toBeVisible();
});

test("a file is typed in as a draft, then confirmed, which charges each customer once", async () => {
  await page.getByRole("link", { name: "Files" }).click();
  await page.getByRole("link", { name: "Type a file in" }).click();
  await page.getByLabel("File code").fill("gssk6931");

  const customers = page.getByRole("combobox");
  const amounts = page.getByLabel("Amount to collect");
  await pick(customers.nth(0), "0750 111 2001", "Rebwar A.");
  await amounts.nth(0).fill("85");
  await pick(customers.nth(0), "dara", "Dara M.");   // the first box left is now the second row's
  await amounts.nth(1).fill("310.00");
  await expect(page.getByText("2 customers · to collect $395.00")).toBeVisible();

  await page.getByRole("button", { name: "Save as a draft" }).click();
  await expect(page.getByRole("heading", { name: "GSSK6931" })).toBeVisible();
  await expect(page.getByText("Not confirmed yet")).toBeVisible();

  await page.getByRole("button", { name: "Confirm the file" }).click();
  await expect(page.getByText("This charges 2 customers $395.00 in all")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm the file" }).click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("2 not delivered")).toBeVisible();
});

test("today's rate is set, and a typing mistake is caught before it is taken", async () => {
  await page.getByRole("link", { name: "Money" }).click();
  await expect(page.getByText("Not set yet. No dinars can be taken today until it is.")).toBeVisible();
  await page.getByLabel("Dinars per $100").fill("145,000");
  await expect(page.getByText("That is 1,450 dinars per dollar.")).toBeVisible();
  await page.getByRole("button", { name: "Set the rate" }).click();
  await expect(page.getByText("Rate today 1,450 IQD per $1")).toBeVisible();

  // 1,450 typed out of habit: far from 145,000, so it is asked again.
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByLabel("Dinars per $100").fill("1450");
  await page.getByRole("button", { name: "Set the rate" }).click();
  await expect(page.getByText("is far from the last rate")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Rate today 1,450 IQD per $1")).toBeVisible();
});

test("a round is made, goes out, and its results are entered from the receipts", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByPlaceholder("Driver's name").fill("Karwan");
  await page.getByPlaceholder("Driver's name").press("Enter");
  await expect(page.getByText("Karwan")).toBeVisible();

  await page.getByRole("link", { name: "Rounds" }).click();
  await page.getByRole("link", { name: "New round" }).click();
  await page.getByLabel("Carried by").selectOption({ label: "Karwan" });
  await page.getByRole("button", { name: "Take all" }).click();
  await expect(page.getByText("2 stops · to collect $395.00")).toBeVisible();
  await page.getByRole("button", { name: "Make the round" }).click();
  await expect(page.getByRole("heading", { name: "Round 1" })).toBeVisible();

  await page.getByRole("button", { name: "He has left" }).click();
  await expect(page.getByText("Out", { exact: true })).toBeVisible();

  // He is back. Rebwar paid in dinars; Dara took his goods on account.
  await page.getByLabel("Outcome for Rebwar A.").selectOption("paid");
  await page.getByLabel("Amount received from Rebwar A.").fill("123,250");
  await page.getByRole("row", { name: /Rebwar A\./ }).getByLabel("Currency").selectOption("IQD");
  await expect(page.getByText("→ about $85.00 at today's 1,450")).toBeVisible();
  await page.getByLabel("Outcome for Dara M.").selectOption("on_account");
  await expect(page.getByText("2 not saved")).toBeVisible();

  await page.getByRole("button", { name: "Save the results" }).click();
  await expect(page.getByText("Back, cash not counted")).toBeVisible();
  await expect(page.getByText("Cash on the receipts: $0.00 · 123,250 IQD")).toBeVisible();
  await expect(page.getByText("→ $85.00 at 1,450")).toBeVisible();
});

test("the driver's cash is counted note by note and goes into the vault", async () => {
  await page.locator("#IQD-25000").fill("4");
  await page.locator("#IQD-10000").fill("2");
  await page.locator("#IQD-1000").fill("3");
  await expect(page.getByText("Short by")).toBeVisible();
  await expect(page.getByLabel("Why the cash and the receipts differ")).toBeVisible();
  await page.locator("#IQD-250").fill("1");
  await expect(page.getByText("Matches")).toHaveCount(2);

  await page.getByRole("button", { name: "Count it into the vault" }).click();
  await expect(page.getByText("Handed in", { exact: true })).toBeVisible();
  await expect(page.getByText("All the cash on the receipts is counted in.")).toBeVisible();
  await expect(page.getByText("Counted in: $0.00 · 123,250 IQD")).toBeVisible();
});

test("the customers' accounts follow: one is paid up, one owes on account, and the file has closed itself", async () => {
  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("row", { name: /Rebwar A\./ })).toContainText("$0.00");
  await expect(page.getByRole("row", { name: /Dara M\./ })).toContainText("$310.00");

  await page.getByRole("link", { name: "Files" }).click();
  const file = page.getByRole("row", { name: /GSSK6931/ });
  await expect(file).toContainText("Closed");
  await expect(file).toContainText("1 on account with a trusted customer");
});

test("a customer pays at the office and it comes off his account", async () => {
  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Dara M." }).click();
  await page.getByRole("link", { name: "Take a payment" }).click();
  await expect(page.getByText("He owes $310.00. It pays his oldest unpaid file first.")).toBeVisible();

  await page.getByLabel("Amount received").fill("85,5");
  await expect(page.getByText("That is not an amount")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the payment" })).toBeDisabled();
  await page.getByLabel("Amount received").fill("100");
  await page.getByRole("button", { name: "Take the payment" }).click();
  await expect(page.getByText("$100.00 taken from Dara M.")).toBeVisible();

  const latest = page.getByRole("row", { name: /Dara M\./ }).first();
  await expect(latest).toContainText("Cash at the office");
  await expect(latest).toContainText("$100.00");

  await page.getByRole("link", { name: "Dara M." }).first().click();
  await expect(page.getByText("$210.00").first()).toBeVisible();
});

test("the vault is closed by counting it, and matches what was entered", async () => {
  await page.getByRole("link", { name: "Vault close" }).click();
  await expect(page.getByText("should be $100.00")).toBeVisible();
  await expect(page.getByText("should be 123,250 IQD")).toBeVisible();

  await page.locator("#USD-5000").fill("1");
  await page.locator("#IQD-25000").fill("4");
  await page.locator("#IQD-10000").fill("2");
  await page.locator("#IQD-1000").fill("3");
  await page.locator("#IQD-250").fill("1");

  // $50 short: it cannot be closed without saying why.
  await expect(page.getByRole("button", { name: "Close the vault" })).toBeDisabled();
  await page.locator("#USD-5000").fill("2");
  await expect(page.getByText("Matches")).toHaveCount(2);
  await page.getByRole("button", { name: "Close the vault" }).click();
  await expect(page.getByText("The vault is closed for today")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take back" })).toBeVisible();
});

test("the China account shows what the file added", async () => {
  await page.getByRole("link", { name: "China account" }).click();
  await expect(page.getByText("Owed to China now")).toBeVisible();
  await expect(page.getByText("$395.00").first()).toBeVisible();
  await expect(page.getByText("File confirmed").first()).toBeVisible();
});

test("the driver forgot to collect: it is on Today the moment the round is saved, and is resolved with a note", async () => {
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByText("No rounds today")).toBeVisible();

  // A pay-first customer on a new file.
  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name").fill("Hemn S.");
  await page.getByLabel("Phone").fill("0750 111 2009");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Hemn S." })).toBeVisible();

  await page.getByRole("link", { name: "Files" }).click();
  await page.getByRole("link", { name: "Type a file in" }).click();
  await page.getByLabel("File code").fill("GSSK6934");
  await pick(page.getByRole("combobox").nth(0), "hemn", "Hemn S.");
  await page.getByLabel("Amount to collect").nth(0).fill("62");
  await page.getByRole("button", { name: "Save as a draft" }).click();
  await page.getByRole("button", { name: "Confirm the file" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm the file" }).click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();

  // The driver hands the goods over and comes back with nothing.
  await page.getByRole("link", { name: "Rounds" }).click();
  await page.getByRole("link", { name: "New round" }).click();
  await page.getByLabel("Carried by").selectOption({ label: "Karwan" });
  await page.getByRole("button", { name: "Take all" }).click();
  await page.getByRole("button", { name: "Make the round" }).click();
  await expect(page.getByRole("heading", { name: "Round 2" })).toBeVisible();
  await page.getByRole("button", { name: "He has left" }).click();
  await page.getByLabel("Outcome for Hemn S.").selectOption("unpaid");
  await page.getByRole("button", { name: "Save the results" }).click();
  await expect(page.getByText("Back, cash not counted")).toBeVisible();

  await page.getByRole("link", { name: "Today", exact: true }).click();
  const alert = page.getByRole("listitem").filter({ hasText: "Round 2: Hemn S. got the goods and $62.00 was not collected" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Not collected");
  await expect(page.getByRole("link", { name: /Alerts/ })).toContainText("1");
  await expect(page.getByText("1 of them serious")).toBeVisible();
  await expect(page.getByRole("row", { name: /Round 2/ })).toContainText("1 not collected");

  await alert.getByRole("button", { name: "Resolve" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Resolve" })).toBeDisabled();
  await dialog.getByLabel("What was done about it").fill("Called him. He pays on Thursday.");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Nothing needs you")).toBeVisible();

  await page.getByRole("link", { name: /Alerts/ }).click();
  await expect(page.getByText("Nothing is open")).toBeVisible();
  await page.getByRole("radio", { name: "Resolved" }).click();
  await expect(page.getByText("Called him. He pays on Thursday.")).toBeVisible();
  await expect(page.getByText(/Resolved by Sarkar on/)).toBeVisible();
});

test("a wallet is checked against its app, and a difference becomes an alert", async () => {
  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Hemn S." }).click();
  await page.getByRole("link", { name: "Take a payment" }).click();
  await page.getByLabel("Amount received").fill("20");
  await page.getByLabel("How it was paid").selectOption({ label: "FIB" });
  await page.getByRole("button", { name: "Take the payment" }).click();
  await expect(page.getByText("$20.00 taken from Hemn S.")).toBeVisible();

  const fib = page.getByRole("row", { name: /FIB, dollars/ });
  await expect(fib).toContainText("$20.00");
  await expect(fib).toContainText("Never");
  await fib.getByRole("button", { name: "Check" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("The books say it should show")).toBeVisible();
  await dialog.getByLabel("Balance in the app, in dollars").fill("20");
  await expect(dialog.getByText("It matches the books.")).toBeVisible();
  await dialog.getByLabel("Balance in the app, in dollars").fill("15");
  await expect(dialog.getByText("less than the books")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save the check" })).toBeDisabled();
  await dialog.getByLabel("Why they differ").fill("Sent $5 to the driver from the app");
  await dialog.getByRole("button", { name: "Save the check" }).click();
  await expect(page.getByText("FIB, dollars checked")).toBeVisible();
  await expect(fib).toContainText("$15.00");
  await expect(fib).toContainText("$5.00 less in the app");

  await page.getByRole("link", { name: /Alerts/ }).click();
  await expect(page.getByText("FIB, dollars: the app shows $5.00 less than the books")).toBeVisible();
});

test("a trusted customer's statement is made to send, as an image, a PDF and a text, and marked as sent", async () => {
  await page.getByRole("link", { name: "Statements" }).click();
  const row = page.getByRole("row", { name: /Dara M\./ });
  await expect(row).toContainText("$210.00");
  await expect(row).toContainText("Never");
  await expect(row).toContainText("To send");
  await expect(page.getByText("1 to send this week.")).toBeVisible();
  // Hemn is not trusted, so he is not on the list even though he owes.
  await expect(page.getByRole("row", { name: /Hemn S\./ })).toHaveCount(0);

  await row.getByRole("link", { name: "Statement" }).click();
  await expect(page.getByRole("heading", { name: "Dara M." })).toBeVisible();
  const charge = page.getByRole("row", { name: /File GSSK6931/ }).first();
  await expect(charge).toContainText("$310.00");
  const payment = page.getByRole("row", { name: /Cash at the office/ });
  await expect(payment).toContainText("$100.00");
  await expect(payment).toContainText("$210.00");
  await expect(page.getByText("None yet")).toBeVisible();

  await page.getByRole("button", { name: "Make a statement to send" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Statement for Dara M." })).toBeVisible();
  await expect(dialog.getByLabel("Statement text")).toContainText("You owe $210.00.");
  await expect(dialog.getByLabel("Statement text")).toContainText("GSSK6931");
  await expect(dialog.getByLabel("Statement text")).toContainText("Last payment received: $100.00");

  // The image is drawn by the API, twice the size of the page so it stays sharp on a phone.
  const image = dialog.getByRole("img", { name: "Statement for Dara M." });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), { timeout: 30_000 }).toBe(1520);
  const pdf = await dialog.getByRole("link", { name: "Download the PDF" }).getAttribute("href");
  const fetched = await page.evaluate(async (url) => {
    const response = await fetch(url as string);
    return { status: response.status, type: response.headers.get("content-type"), size: (await response.arrayBuffer()).byteLength };
  }, pdf);
  expect(fetched.status).toBe(200);
  expect(fetched.type).toBe("application/pdf");
  expect(fetched.size).toBeGreaterThan(5_000);

  await dialog.getByRole("button", { name: "I sent it" }).click();
  await expect(page.getByText("Marked as sent")).toBeVisible();
  await expect(page.getByText(/Sent .* by Sarkar/)).toBeVisible();

  await page.getByRole("link", { name: "Statements" }).click();
  await expect(page.getByRole("row", { name: /Dara M\./ })).toContainText("Sent this week");
  await expect(page.getByText("Everyone on this list was sent a statement this week.")).toBeVisible();
});

test("the CEO sets the checks, and signs out a device he no longer uses", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Held in the car, days").fill("0");
  await expect(page.getByRole("button", { name: "Save the checks" })).toBeDisabled();
  await page.getByLabel("Held in the car, days").fill("5");
  await page.getByRole("button", { name: "Save the checks" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await expect(page.getByLabel("Held in the car, days")).toHaveValue("5");

  // The system is his alone: there is no account to add and no office screen to set up.
  await expect(page.getByRole("button", { name: "Add an account" })).toHaveCount(0);
  await expect(page.getByText("Office monitor")).toHaveCount(0);
  const devices = page.locator("section").filter({ has: page.getByRole("heading", { name: "Signed-in devices" }) });
  await expect(devices).toContainText("Sarkar");
  await expect(devices).toContainText("0770 000 0001");
  await expect(devices.getByText("this device")).toHaveCount(1);
  await expect(devices.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  // He signs in on a second device. It shows up here, and he signs it out from this one.
  const other = await page.context().browser()!.newContext();
  const phone = await other.newPage();
  await phone.goto("/sign-in");
  await phone.getByLabel("Phone number").fill("0770 000 0001");
  await phone.getByLabel("Password").fill(PASSWORD);
  await phone.getByRole("button", { name: "Sign in" }).click();
  await expect(phone.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  await page.reload();
  await expect(devices.getByRole("button", { name: "Sign out" })).toHaveCount(1);
  await devices.getByRole("button", { name: "Sign out" }).click();
  await expect(devices.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(devices.getByText("this device")).toHaveCount(1);
  await phone.goto("/customers");
  await expect(phone).toHaveURL(/\/sign-in/);
  await other.close();
});

/** Sets a scene through the API, the way the screens do, for the steps that are about one thing only. */
async function send<T = { id: string }>(method: string, url: string, body: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const reply = await fetch(url, { method, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      if (!reply.ok) throw new Error(`${method} ${url}: ${reply.status} ${await reply.text()}`);
      return reply.json();
    },
    { method, url, body },
  );
}

/** A customer who owes this much on one confirmed file. */
async function owing(name: string, cents: number, code: string): Promise<{ customerId: string; consignmentId: string }> {
  const customer = await send("POST", "/v1/customers", { name });
  const file = await send<{ id: string; consignmentList: { id: string }[] }>("POST", "/v1/shipments", { code, consignments: [{ customerId: customer.id, amountDueUsdCents: cents }] });
  await send("POST", `/v1/shipments/${file.id}/confirm`);
  return { customerId: customer.id, consignmentId: (file.consignmentList[0] as { id: string }).id };
}

test("a customer pays in dollars and dinars together, and the rounded dinars settle what he owes", async () => {
  const { customerId } = await owing("Mixed Payer", 53_300, "GSSK7001");
  await page.goto(`/money?customer=${customerId}`);
  await expect(page.getByText("He owes $533.00. It pays his oldest unpaid file first.")).toBeVisible();

  // $400 in dollars. The rest, $133, is 192,850 dinars at 1,450: he hands over 193,000.
  await page.getByLabel("Amount received").fill("400");
  await page.getByRole("button", { name: "+ He also paid another way" }).click();
  const second = page.locator('[data-part="2"]');
  await expect(second.getByLabel("Currency")).toHaveValue("IQD");
  await expect(second).toContainText("What is left is 192,850 IQD.");
  await second.getByRole("button", { name: "Use 193,000 IQD" }).click();
  await expect(second.getByLabel("And")).toHaveValue("193000");
  await expect(second).toContainText("counts as $133.00: it settles what he owes. Exactly, it is $133.10 at 1,450.");
  await expect(page.getByTestId("payment-total")).toHaveText("Together $533.00. He will owe nothing.");

  // Two rows the same way are one payment.
  await second.getByLabel("Currency").selectOption("USD");
  await expect(page.getByText("Two of these are in the same currency and paid the same way.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the payment" })).toBeDisabled();
  await second.getByLabel("Currency").selectOption("IQD");

  await page.getByRole("button", { name: "Take the payment" }).click();
  await expect(page.getByText("$533.00 taken from Mixed Payer")).toBeVisible();
  const rows = page.getByRole("row", { name: /Mixed Payer/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "193,000 IQD" })).toContainText("$133.00");
  await expect(rows.filter({ hasText: "$400.00" })).toHaveCount(1);

  await page.goto(`/customers/${customerId}/statement`);
  await expect(page.getByText("He owes", { exact: true }).locator("..")).toContainText("$0.00");
});

test("a few dollars nobody will chase are taken off with an Error entry, up to the limit in Settings", async () => {
  const { customerId } = await owing("Error Payer", 10_000, "GSSK7002");
  await page.goto(`/money?customer=${customerId}`);
  await page.getByRole("radio", { name: "Error" }).click();
  await expect(page.getByText("He owes $100.00.")).toBeVisible();
  await expect(page.getByText("At most $5.00 at a time.")).toBeVisible();

  await page.getByLabel("Amount to take off, in dollars").fill("7");
  await expect(page.getByText("At most $5.00. The limit is in Settings.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter the error" })).toBeDisabled();
  await page.getByLabel("Amount to take off, in dollars").fill("4.50");
  await page.getByLabel("Note").fill("Short at the door");
  await page.getByRole("button", { name: "Enter the error" }).click();
  await expect(page.getByText("$4.50 taken off Error Payer's account")).toBeVisible();

  const listed = page.locator("section").filter({ has: page.getByRole("heading", { name: "Latest errors" }) }).getByRole("row", { name: /Error Payer/ });
  await expect(listed).toContainText("$4.50");
  await expect(listed).toContainText("Short at the door");
  // No money came in: it is not on the list of payments.
  await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Latest payments" }) }).getByRole("row", { name: /Error Payer/ })).toHaveCount(0);

  // His limit is his own to change.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByLabel("Round dinars to the nearest")).toHaveValue("1000");
  await page.getByLabel("An Error entry is at most, in dollars").fill("10");
  await page.getByRole("button", { name: "Save the money rules" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto(`/money?customer=${customerId}`);
  await page.getByRole("radio", { name: "Error" }).click();
  await expect(page.getByText("He owes $95.50.")).toBeVisible();
  await page.getByLabel("Amount to take off, in dollars").fill("7");
  await page.getByRole("button", { name: "Enter the error" }).click();
  await expect(page.getByText("$7.00 taken off Error Payer's account")).toBeVisible();

  // Taken back like any other entry.
  await listed.filter({ hasText: "$7.00" }).getByRole("button", { name: "Reverse" }).click();
  await page.getByRole("dialog").getByLabel("Why").fill("He paid it after all");
  await page.getByRole("dialog").getByRole("button", { name: "Reverse it" }).click();
  await expect(listed.filter({ hasText: "$7.00" })).toContainText("reversed");

  await page.goto(`/customers/${customerId}/statement`);
  await expect(page.getByText("He owes", { exact: true }).locator("..")).toContainText("$95.50");
  await expect(page.getByRole("row", { name: /Error/ }).first()).toContainText("$4.50");
});

test("at the door a customer pays the driver in dollars and dinars, and the driver holds both", async () => {
  const { consignmentId } = await owing("Door Payer", 53_300, "GSSK7003");
  const driver = await send("POST", "/v1/drivers", { name: "Bestun" });
  const round = await send<{ id: string; number: number }>("POST", "/v1/rounds", { driverId: driver.id, stops: [{ consignmentId }] });
  await send("POST", `/v1/rounds/${round.id}/depart`);

  await page.goto(`/rounds/${round.id}`);
  await page.getByLabel("Outcome for Door Payer").selectOption("paid");
  await page.getByLabel("Amount received from Door Payer").fill("400");
  await page.getByRole("button", { name: "Door Payer also paid another way" }).click();
  // Not ready to save while the second amount is empty.
  await expect(page.getByText("Enter the other amount, or remove the empty row.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save the results" })).toBeDisabled();
  await page.getByLabel("Payment 2 from Door Payer").fill("193,000");
  await expect(page.getByLabel("Currency of payment 2")).toHaveValue("IQD");
  await expect(page.getByText("193,000 IQD → counts as $133.00: it settles what is left")).toBeVisible();
  await expect(page.getByText("Together $533.00, paid in full")).toBeVisible();

  await page.getByRole("button", { name: "Save the results" }).click();
  await expect(page.getByText("Back, cash not counted")).toBeVisible();
  await expect(page.getByText("Cash on the receipts: $400.00 · 193,000 IQD")).toBeVisible();
  await expect(page.getByText("193,000 IQD → $133.00 at 1,450")).toBeVisible();
  await expect(page.getByLabel("Amount received from Door Payer")).toHaveValue("400.00");
  await expect(page.getByLabel("Payment 2 from Door Payer")).toHaveValue("193000");
  await expect(page.getByText("The driver forgot to collect.")).toHaveCount(0);

  // He hands in the dollars and the dinars, and the round is done.
  await page.locator("#USD-10000").fill("4");
  await page.locator("#IQD-50000").fill("3");
  await page.locator("#IQD-25000").fill("1");
  await page.locator("#IQD-10000").fill("1");
  await page.locator("#IQD-5000").fill("1");
  await page.locator("#IQD-1000").fill("3");
  await expect(page.getByText("Matches")).toHaveCount(2);
  await page.getByRole("button", { name: "Count it into the vault" }).click();
  await expect(page.getByText("All the cash on the receipts is counted in.")).toBeVisible();
  await expect(page.getByText("Counted in: $400.00 · 193,000 IQD")).toBeVisible();
});

test("signed out, nothing opens: every screen asks him to sign in, and the API answers nobody", async () => {
  // The office screen is gone, whoever asks for it.
  await page.goto("/monitor");
  await expect(page.getByText("404")).toBeVisible();
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  for (const screen of ["/today", "/customers", "/money", "/vault", "/settings"]) {
    await page.goto(screen);
    await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(screen)}`));
  }
  const refused = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const url of ["/v1/me", "/v1/customers", "/v1/alerts", "/v1/reports/today", "/v1/vault", "/v1/settings", "/v1/users", "/v1/monitor"]) {
      out[url] = (await fetch(url)).status;
    }
    const added = await fetch("/v1/customers", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "Added by nobody" }),
    });
    out["POST /v1/customers"] = added.status;
    return out;
  });
  expect(refused).toEqual({
    "/v1/me": 401,
    "/v1/customers": 401,
    "/v1/alerts": 401,
    "/v1/reports/today": 401,
    "/v1/vault": 401,
    "/v1/settings": 401,
    "/v1/users": 401,
    "/v1/monitor": 404,
    "POST /v1/customers": 401,
  });
});
