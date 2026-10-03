// Creates the CEO's account, or gives him a new password if he has lost his.
//
//   pnpm --filter @green-star/api create-ceo -- --name "Name" --phone "0770 123 4567"
//
// It asks for the password without showing it. Run it where the system is
// hosted: it uses DATABASE_URL, the login that owns the database, because
// nobody is signed in yet. Every other account is added by the CEO in the app.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@green-star/contracts";
import { normalizePhone } from "@green-star/domain";
import pg from "pg";
import { hashPassword } from "../src/auth/passwords.ts";
import { SCRYPT_COST } from "../src/config.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(rl);
    let asked = false;
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!asked) write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    asked = true;
  });
}

const { values } = parseArgs({
  // pnpm passes a bare "--" through when the command is typed with one.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { name: { type: "string" }, phone: { type: "string" } },
});

const url = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set. Copy .env.example to .env.");
const name = values.name?.trim() || fail('Say who he is: --name "Name"');
const phone = normalizePhone(values.phone ?? "") ?? fail('Give his phone number: --phone "0770 123 4567"');

// GS_PASSWORD is for automated set-up only. A person is asked, twice.
let password = process.env.GS_PASSWORD;
if (password === undefined) {
  password = await askHidden(`Password for ${name} (at least ${PASSWORD_MIN_LENGTH} characters): `);
  if ((await askHidden("The same password again: ")) !== password) fail("The two passwords are not the same. Nothing was saved.");
}
if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  fail(`A password is ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. Nothing was saved.`);
}

const hash = await hashPassword(password, SCRYPT_COST);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("begin");
  const existing = await client.query<{ id: string; role: string }>("select id, role from users where phone = $1", [phone]);
  let id: string;
  let did: string;
  const row = existing.rows[0];
  if (row === undefined) {
    const made = await client.query<{ id: string }>(
      "insert into users (name, role, phone) values ($1, 'ceo', $2) returning id",
      [name, phone],
    );
    id = (made.rows[0] as { id: string }).id;
    did = "Created the CEO's account";
  } else if (row.role !== "ceo") {
    throw new Error(`${phone} already belongs to the ${row.role}'s account. Nothing was saved.`);
  } else {
    id = row.id;
    await client.query("update users set name = $2, active = true where id = $1", [id, name]);
    await client.query("update sessions set revoked_at = now(), revoked_by = $1 where user_id = $1 and revoked_at is null", [id]);
    did = "Set a new password for the CEO and signed him out everywhere";
  }
  await client.query(
    `insert into user_credentials (user_id, password_hash) values ($1, $2)
     on conflict (user_id) do update set password_hash = excluded.password_hash`,
    [id, hash],
  );
  await client.query("commit");
  console.log(`${did}: ${name}, ${phone}.`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end();
}
