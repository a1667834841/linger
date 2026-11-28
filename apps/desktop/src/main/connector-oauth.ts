import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { ConnectorOAuthResponse } from "../shared/api.js";

const CALLBACK_PREFIX = "/oauth/connector/";
const CALLBACK_TTL = 15 * 60_000;
const MAX_CALLBACKS = 32;
type ReturnHandler = (
  connectedAccountId?: string,
  customMCP?: ConnectorOAuthResponse,
) => void;

export class ConnectorOAuth {
  #server?: Server;
  #origin?: Promise<string>;
  readonly #pending = new Map<
    string,
    { expires: number; onReturn: ReturnHandler; customMCP: boolean }
  >();

  async prepare(onReturn: ReturnHandler, endpoint?: string): Promise<string> {
    const origin = await (this.#origin ??= this.#listen());
    const now = Date.now();
    for (const [key, attempt] of this.#pending) {
      if (attempt.expires <= now) this.#pending.delete(key);
    }
    // Exact redirect matching requires the same path when reusing a client registration.
    const id =
      endpoint === undefined
        ? randomBytes(24).toString("hex")
        : createHash("sha256").update(endpoint).digest("hex").slice(0, 48);
    const pathname = CALLBACK_PREFIX + id;
    if (!this.#pending.has(pathname) && this.#pending.size >= MAX_CALLBACKS) {
      throw new Error("Too many connector authorizations in progress");
    }
    this.#pending.set(pathname, {
      expires: now + CALLBACK_TTL,
      onReturn,
      customMCP: endpoint !== undefined,
    });
    return origin + pathname;
  }

  #listen(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = createServer({ requestTimeout: 10_000 }, (req, res) => {
        const address = server.address();
        const host =
          address && typeof address !== "string"
            ? `127.0.0.1:${address.port}`
            : "";
        res.setHeader("Cache-Control", "no-store");
        if (
          !host ||
          req.method !== "GET" ||
          req.headers.host !== host ||
          !req.url?.startsWith(CALLBACK_PREFIX)
        ) {
          res.writeHead(404).end("Authorization callback not found.");
          return;
        }
        const url = new URL(req.url, `http://${host}`);
        const attempt = this.#pending.get(url.pathname);
        if (!attempt || attempt.expires <= Date.now()) {
          res.writeHead(404).end("Authorization callback not found.");
          return;
        }
        const response = attempt.customMCP ? customMCPResponse(url) : undefined;
        if (attempt.customMCP && !response) {
          res.writeHead(400).end("Invalid authorization response.");
          return;
        }
        // TeamHub consumes custom MCP state atomically. Keep the stable redirect
        // available so a second authorization for this endpoint can return.
        if (!attempt.customMCP) this.#pending.delete(url.pathname);
        const account = url.searchParams.get("connected_account_id");
        res
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'",
            "Referrer-Policy": "no-referrer",
          })
          .end(
            "<!doctype html><html lang=en><meta charset=utf-8><title>Linger authorization</title><h1>Go back to Linger</h1><p>Linger received the authorization response. Check the connector status in the app. You can close this tab.</p>",
          );
        if (response) attempt.onReturn(undefined, response);
        else {
          attempt.onReturn(
            account && /^[a-zA-Z0-9_-]{1,256}$/.test(account)
              ? account
              : undefined,
          );
        }
      });
      this.#server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        const address = server.address();
        if (address && typeof address !== "string")
          resolve(`http://127.0.0.1:${address.port}`);
      });
    }).catch((error: unknown) => {
      this.#origin = undefined;
      throw error;
    });
  }

  stop(): void {
    this.#pending.clear();
    this.#server?.close();
    this.#server?.closeAllConnections();
  }
}

function customMCPResponse(url: URL): ConnectorOAuthResponse | undefined {
  const query = url.searchParams;
  for (const key of ["state", "code", "iss", "error"]) {
    const values = query.getAll(key);
    if (values.length > 1 || values[0] === "") return undefined;
  }
  const state = query.get("state");
  const code = query.get("code") ?? undefined;
  const error = query.get("error") ?? undefined;
  const iss = query.get("iss") ?? undefined;
  if (
    url.search.length > 16_384 ||
    !state ||
    !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
    Boolean(code) === Boolean(error)
  ) {
    return undefined;
  }
  return {
    state,
    code,
    error,
    iss,
    callback_id: url.pathname.slice(CALLBACK_PREFIX.length),
  };
}
