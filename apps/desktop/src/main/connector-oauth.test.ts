import { expect, it, vi } from "vitest";

import { ConnectorOAuth } from "./connector-oauth.js";

it("accepts only the assigned browser callback and consumes it once", async () => {
  const oauth = new ConnectorOAuth();
  const returned = vi.fn();
  try {
    const callback = new URL(await oauth.prepare(returned));
    expect(callback.hostname).toBe("127.0.0.1");
    const wrong = new URL("wrong", callback);
    expect((await fetch(wrong)).status).toBe(404);
    expect((await fetch(callback, { method: "POST" })).status).toBe(404);
    expect(returned).not.toHaveBeenCalled();

    callback.searchParams.set("connected_account_id", "ca_returned");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("back to Linger");
    expect(returned).toHaveBeenCalledExactlyOnceWith("ca_returned");
    expect((await fetch(callback)).status).toBe(404);
  } finally {
    oauth.stop();
  }
});

it("reuses the MCP redirect and forwards a structured callback without accepting duplicate parameters", async () => {
  const oauth = new ConnectorOAuth();
  const returned = vi.fn();
  try {
    const endpoint = "https://mcp.example/mcp";
    const callback = new URL(await oauth.prepare(returned, endpoint));
    expect(await oauth.prepare(returned, endpoint)).toBe(callback.href);
    callback.searchParams.set("state", "x".repeat(43));
    callback.searchParams.set("iss", "https://issuer.example");
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.append("state", "y".repeat(43));
    expect((await fetch(callback)).status).toBe(400);
    expect(returned).not.toHaveBeenCalled();

    callback.searchParams.set("state", "x".repeat(43));
    expect((await fetch(callback)).status).toBe(200);
    expect(returned).toHaveBeenCalledExactlyOnceWith(undefined, {
      state: "x".repeat(43),
      code: "fixture-code",
      iss: "https://issuer.example",
      error: undefined,
      callback_id: callback.pathname.split("/").at(-1),
    });
  } finally {
    oauth.stop();
  }
});
