// A day at the office, in a real browser: a file arrives, a round goes out and
// comes back, the cash is counted, a customer pays, the vault is closed.
// Each step starts where the one before it ended.

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "office password 1";
const OWNER_PASSWORD = "the owner's password";
const MONITOR_PASSWORD = "the office screen 1";

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

test("the CEO sets the checks and picks what the office screen shows; the screen shows no money", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Held in the car, days").fill("0");
  await expect(page.getByRole("button", { name: "Save the checks" })).toBeDisabled();
  await page.getByLabel("Held in the car, days").fill("5");
  await page.getByRole("button", { name: "Save the checks" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await expect(page.getByLabel("Held in the car, days")).toHaveValue("5");

  await page.getByRole("button", { name: "Add an account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account for").selectOption("monitor");
  await dialog.getByLabel("Name", { exact: true }).fill("Office TV");
  await dialog.getByLabel("Sign-in name").fill("office-tv");
  await dialog.getByLabel("Password").fill(MONITOR_PASSWORD);
  await dialog.getByRole("button", { name: "Add the account" }).click();
  await expect(page.getByText("Office TV")).toBeVisible();

  await page.getByLabel("Files", { exact: false }).first().uncheck();
  await page.getByRole("button", { name: "Save the screen" }).click();
  await expect(page.getByText("The office screen is updated")).toBeVisible();

  await page.getByRole("link", { name: "Open the screen" }).click();
  await expect(page).toHaveURL(/\/monitor$/);
  await expect(page.getByRole("heading", { name: "Rounds" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Held in the car" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Files" })).toHaveCount(0);
  const round = page.getByRole("listitem").filter({ hasText: "Round 2" });
  await expect(round).toContainText("Karwan");
  await expect(round).toContainText("Back");
  await expect(round).toContainText("1 of 1 stops done");
  await expect(page.getByText("Nothing is held.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("$");
  await expect(page.locator("body")).not.toContainText("IQD");

  await page.getByRole("link", { name: "Back to the office" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("the owner is given an account, sees every screen, and can change nothing", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add an account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Kak Azad");
  await dialog.getByLabel("Phone number").fill("0770 000 0002");
  await dialog.getByLabel("Password").fill(OWNER_PASSWORD);
  await dialog.getByRole("button", { name: "Add the account" }).click();
  await expect(page.getByText("Kak Azad")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn("0770 000 0002", OWNER_PASSWORD);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Owner · read only")).toBeVisible();
  // He sees the open alert, and cannot resolve it.
  await expect(page.getByText("FIB, dollars: the app shows $5.00 less than the books")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);

  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New customer" })).toHaveCount(0);

  await page.getByRole("link", { name: "Dara M." }).click();
  await expect(page.getByText("$210.00").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Take a payment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Trust and limit" })).toHaveCount(0);

  await page.getByRole("link", { name: "Money" }).click();
  await expect(page.getByText("Latest payments")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the payment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reverse" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /FIB, dollars/ })).toContainText("$15.00");
  await expect(page.getByRole("button", { name: "Check" })).toHaveCount(0);

  await page.getByRole("link", { name: "Vault close" }).click();
  await expect(page.getByText("The CEO closes the vault")).toBeVisible();

  await page.getByRole("link", { name: "Rounds" }).click();
  await expect(page.getByRole("link", { name: "New round" })).toHaveCount(0);
  await page.getByRole("link", { name: "Round 1" }).click();
  await expect(page.getByText("The CEO counts the cash in.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save the results" })).toHaveCount(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "My password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add an account" })).toHaveCount(0);
  await expect(page.getByLabel("Held in the car, days")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save the checks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save the screen" })).toHaveCount(0);

  // Even asked directly, the API refuses him.
  const refused = await page.evaluate(async () => {
    const response = await fetch("/v1/customers", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "Added by the owner" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(refused).toEqual({ status: 403, body: { code: "not_allowed", message: "Your account cannot do this" } });
});

test("the office monitor signs in to its own screen and reaches nothing else", async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn("office-tv", MONITOR_PASSWORD);
  await expect(page).toHaveURL(/\/monitor$/);
  await expect(page.getByRole("heading", { name: "Rounds" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to the office" })).toHaveCount(0);

  // The office itself sends it back to its screen.
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/monitor$/);
  await expect(page.getByRole("heading", { name: "Rounds" })).toBeVisible();

  const refused = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const url of ["/v1/customers", "/v1/alerts", "/v1/reports/today", "/v1/vault", "/v1/settings"]) {
      out[url] = (await fetch(url)).status;
    }
    return out;
  });
  expect(refused).toEqual({ "/v1/customers": 403, "/v1/alerts": 403, "/v1/reports/today": 403, "/v1/vault": 403, "/v1/settings": 403 });
});
