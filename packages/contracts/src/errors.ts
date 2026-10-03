// Every error the API returns has this shape, with a code that never changes:
// { "code": "rate_missing", "message": "Set today's dinar rate first" }

import { z } from "zod";

export const ApiErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  /** Which fields of the request were wrong, when the code is invalid_request. */
  fields: z.record(z.string(), z.string()).optional(),
  /** How long to wait, when the code is too_many_attempts. */
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
