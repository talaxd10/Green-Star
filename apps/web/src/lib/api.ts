// Talking to the API. The browser calls /v1 on this app's own address; the
// app passes it on (next.config.ts), so the session cookie never crosses sites.

import type { ApiErrorBody } from "@green-star/contracts";

/** The API said no. `code` never changes; `message` is for a person. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.message ?? "Something went wrong");
    this.name = "ApiFailure";
    this.status = status;
    this.code = body.code ?? "unknown";
    this.fields = body.fields ?? {};
    this.retryAfterSeconds = body.retryAfterSeconds;
  }
}

/** One new value for each click on Save. Sent twice, the API does the work once. */
export const newKey = (): string => crypto.randomUUID();

async function request<T>(method: string, url: string, body?: unknown, key?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = key ?? newKey();

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiFailure(0, { code: "offline", message: "Could not reach the server. Nothing was saved. Check the connection and try again." });
  }
  if (response.status === 204) return undefined as T;

  let parsed: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw new ApiFailure(response.status, (parsed ?? {}) as Partial<ApiErrorBody>);
  return parsed as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}, key?: string) => request<T>("POST", url, body, key),
  put: <T>(url: string, body: unknown, key?: string) => request<T>("PUT", url, body, key),
  patch: <T>(url: string, body: unknown, key?: string) => request<T>("PATCH", url, body, key),
  del: <T>(url: string, key?: string) => request<T>("DELETE", url, undefined, key),
};

/** Builds "/v1/customers?q=...&trust=..." and leaves out what is empty. */
export function withQuery(url: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(name, String(value));
  }
  const text = params.toString();
  return text.length === 0 ? url : `${url}?${text}`;
}
