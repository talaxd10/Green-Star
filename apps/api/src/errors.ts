// Errors, as the office app sees them: { "code": "rate_missing", "message": "..." }.
// The code never changes; the message is for a person.

import type { ApiErrorBody } from "@green-star/contracts";
import { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  body(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.fields === undefined ? {} : { fields: this.fields }),
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

export const notSignedIn = () => new ApiError(401, "not_signed_in", "Sign in first");
export const notAllowed = () => new ApiError(403, "not_allowed", "Your account cannot do this");
export const notFound = (what = "That") => new ApiError(404, "not_found", `${what} was not found`);

export function invalidRequest(error: z.ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? "_" : issue.path.join(".");
    fields[key] ??= issue.message;
  }
  const first = Object.entries(fields)[0];
  const message = first === undefined ? "The request is not valid" : first[0] === "_" ? first[1] : `${first[0]}: ${first[1]}`;
  return new ApiError(400, "invalid_request", message, { fields });
}

/** Checks a request against its shape from packages/contracts. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw invalidRequest(result.error);
  return result.data;
}

// ---------------------------------------------------------------------------
// Errors the database raises
// ---------------------------------------------------------------------------

interface DatabaseError {
  code: string;
  message: string;
  constraint?: string;
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
  );
}

/** A value that must be unique was used twice. */
const TAKEN: Record<string, [code: string, message: string]> = {
  users_phone_key: ["phone_taken", "That phone number already has an account"],
  users_sign_in_name_key: ["name_taken", "That sign-in name is already used"],
  customer_phones_phone_key: ["customer_phone_taken", "That phone number already belongs to a customer"],
  customer_marks_mark_key: ["mark_taken", "That mark already belongs to a customer"],
  shipments_code_key: ["file_code_taken", "There is already a file with that code"],
  consignments_one_per_customer_per_file: ["customer_twice_on_file", "That customer is already on this file"],
  exceptions_consignment_id_key: ["exception_exists", "An exception was already allowed for these goods"],
  rounds_pkey: ["round_exists", "That round already exists"],
};

/** A rule on one value. Reached only when a request got past the checks here. */
const RULES: Record<string, string> = {
  customer_phones_format: "That is not a phone number",
  drivers_phone_format: "That is not a phone number",
  rounds_driver_or_carrier: "Pick a driver or a carrier",
  consignments_other_within_amount: "Other charges cannot be more than the amount to collect",
  users_phone_format: "That is not a phone number",
  users_sign_in_name_format: "A sign-in name is 3 to 32 letters or digits, starting with a letter",
  users_name_not_blank: "Enter a name",
};

/**
 * The database's own rules raise "code: message for a person". These codes
 * mean the API itself is wrong, not the request, and are not shown.
 */
const INTERNAL = new Set(["actor_required", "actor_unknown", "actor_invalid", "actor_mismatch"]);

function statusFor(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "ceo_only") return 403;
  return 422;
}

/** Turns a database error into the API's error, or null when it is not one a person caused. */
export function fromDatabase(error: unknown): ApiError | null {
  if (!isDatabaseError(error)) return null;

  if (error.code === "P0001") {
    const match = /^([a-z][a-z0-9_]*)(?::\s*(.*))?$/s.exec(error.message);
    if (match === null) return null;
    const code = match[1] as string;
    if (INTERNAL.has(code)) return null;
    const message = match[2]?.trim();
    return new ApiError(statusFor(code), code, message && message.length > 0 ? message : code.replaceAll("_", " "));
  }
  if (error.code === "23505") {
    const known = error.constraint === undefined ? undefined : TAKEN[error.constraint];
    return known === undefined
      ? new ApiError(409, "already_exists", "That already exists")
      : new ApiError(409, known[0], known[1]);
  }
  if (error.code === "23514") {
    const name = error.constraint ?? "rule_broken";
    return new ApiError(422, name, RULES[name] ?? "That value is not allowed");
  }
  if (error.code === "23503") {
    return new ApiError(422, "reference_missing", "That refers to something that does not exist");
  }
  if (error.code === "40P01" || error.code === "40001") {
    return new ApiError(503, "busy", "The system was busy. Nothing was saved. Try again.");
  }
  return null;
}
