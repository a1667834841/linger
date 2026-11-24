// Sends the phone's diagnostics to the receiver the desktop app uses
// (docs/diagnostics-upload.md, linger.diagnostics-upload/v1): one POST asks
// for a report id and a one-time upload URL, one PUT sends the zip there.
// The zip holds the phone's log, which carries no content.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { strToU8, zipSync } from "fflate";

export const DIAGNOSTICS_UPLOAD_SCHEMA = "linger.diagnostics-upload/v1";
/** The receiver files phone reports apart from the desktop's by this name. */
export const MOBILE_CLIENT_NAME = "linger-mobile";
const MAX_BYTES = 50 * 1024 * 1024;
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export class DiagnosticsUploadError extends Error {
  constructor(
    message: string,
    /** Whether Try Again can help. */
    readonly retry: boolean,
  ) {
    super(message);
    this.name = "DiagnosticsUploadError";
  }
}

/** https, or http to this machine while developing a receiver. */
export function isUploadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

export function diagnosticsZip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

interface Ticket {
  readonly reportId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

function readTicket(value: unknown): Ticket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ticket = value as Record<string, unknown>;
  const upload = ticket.upload as Record<string, unknown> | undefined;
  if (
    ticket.schema !== DIAGNOSTICS_UPLOAD_SCHEMA ||
    typeof ticket.reportId !== "string" ||
    !REPORT_ID.test(ticket.reportId) ||
    upload?.method !== "PUT" ||
    typeof upload.url !== "string" ||
    !isUploadUrl(upload.url)
  )
    return undefined;
  const headers: Record<string, string> = {};
  if (typeof upload.headers === "object" && upload.headers !== null)
    for (const [name, header] of Object.entries(upload.headers))
      if (
        typeof header === "string" &&
        !RESERVED_HEADERS.has(name.toLowerCase())
      )
        headers[name] = header;
  return { reportId: ticket.reportId, url: upload.url, headers };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown };
    };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not the error envelope.
  }
  return `The receiver answered ${response.status}.`;
}

/** Uploads a zip and returns the report id the Human gives to support. */
export async function uploadDiagnostics(input: {
  readonly endpoint: string;
  readonly zip: Uint8Array;
  readonly client: { readonly version: string; readonly platform: string };
  readonly fetch?: typeof fetch;
}): Promise<string> {
  const send = input.fetch ?? fetch;
  if (input.zip.length > MAX_BYTES)
    throw new DiagnosticsUploadError(
      "The diagnostics are too large to send.",
      false,
    );
  let asked: Response;
  try {
    asked = await send(input.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: DIAGNOSTICS_UPLOAD_SCHEMA,
        size: input.zip.length,
        sha256: bytesToHex(sha256(input.zip)),
        client: { name: MOBILE_CLIENT_NAME, ...input.client },
      }),
    });
  } catch {
    throw new DiagnosticsUploadError(
      "The receiver could not be reached.",
      true,
    );
  }
  // React Native's fetch follows redirects whatever `redirect` says, so an
  // answer from anywhere but the configured receiver is refused here: only
  // that receiver may say where the report goes.
  if (asked.redirected || (asked.url && asked.url !== input.endpoint))
    throw new DiagnosticsUploadError(
      "The receiver sent the report somewhere else.",
      false,
    );
  if (!asked.ok)
    throw new DiagnosticsUploadError(
      await errorMessage(asked),
      asked.status === 429 || asked.status >= 500,
    );
  const ticket = readTicket(await asked.json().catch(() => undefined));
  if (!ticket)
    throw new DiagnosticsUploadError(
      "The receiver sent an unusable answer.",
      false,
    );
  let uploaded: Response;
  try {
    uploaded = await send(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      // React Native's fetch takes an ArrayBuffer body, not a typed array.
      body: input.zip.slice().buffer,
    });
  } catch {
    throw new DiagnosticsUploadError("The upload did not finish.", true);
  }
  if (!uploaded.ok)
    throw new DiagnosticsUploadError(
      "The upload was refused.",
      uploaded.status === 403 || uploaded.status >= 500,
    );
  return ticket.reportId;
}
