import { describe, test, expect, mock } from "bun:test";

import { BhwClient } from "../src/client.js";
import type { BhwSession, BhwFetchInit, BhwFetchResponse } from "../src/session.js";

const ORIGIN = "https://www.blackhatworld.com/";

/** Minimal mock session that records calls and returns scripted responses. */
function mockSession(
  handler: (url: URL, init?: BhwFetchInit) => { status: number; body: string; url?: string },
): BhwSession {
  const calls: Array<{ url: string; init?: BhwFetchInit }> = [];
  return {
    origin: new URL(ORIGIN),
    async fetch(url: string | URL, init?: BhwFetchInit): Promise<BhwFetchResponse> {
      const resolved = url instanceof URL ? url : new URL(url, ORIGIN);
      calls.push({ url: resolved.href, init });
      const result = handler(resolved, init);
      return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        url: result.url ?? resolved.href,
        async text() {
          return result.body;
        },
        async json() {
          return JSON.parse(result.body);
        },
      };
    },
    async close() {},
  };
}

describe("BhwClient with mock transport", () => {
  test("constructor accepts a pre-built session", () => {
    const session = mockSession(() => ({ status: 200, body: "" }));
    const client = new BhwClient({ session });
    expect(client.origin.href).toBe(ORIGIN);
  });

  test("ensureToken fetches home page and extracts token", async () => {
    const session = mockSession(() => ({
      status: 200,
      body: `<input type="hidden" name="_xfToken" value="1700000000,abc123">`,
    }));
    const client = new BhwClient({ session });
    const token = await client.ensureToken();
    expect(token).toBe("1700000000,abc123");
    expect(client.xfToken).toBe("1700000000,abc123");
  });

  test("ensureToken returns cached token on second call", async () => {
    let fetchCount = 0;
    const session = mockSession(() => {
      fetchCount++;
      return {
        status: 200,
        body: `<input type="hidden" name="_xfToken" value="1700000000,abc123">`,
      };
    });
    const client = new BhwClient({ session });
    await client.ensureToken();
    await client.ensureToken();
    expect(fetchCount).toBe(1);
  });

  test("validateUsername delegates to transport with AJAX envelope", async () => {
    const session = mockSession((url) => {
      expect(url.pathname).toBe("/misc/validate-username");
      return {
        status: 200,
        body: JSON.stringify({ status: "ok", valid: true }),
      };
    });
    const client = new BhwClient({ session });
    const result = await client.validateUsername("testuser");
    expect(result).toBeDefined();
  });

  test("close does not throw when client owns session", async () => {
    const session = mockSession(() => ({ status: 200, body: "" }));
    const client = new BhwClient({ session, ownsSession: false });
    await client.close();
  });

  test("create wires a provided captcha solver", async () => {
    const session = mockSession(() => ({ status: 200, body: "" }));
    const client = await BhwClient.create({
      session,
      captchaSolver: {
        async solve() {
          throw new Error("not needed for construction");
        },
      },
    });
    expect(client.origin.href).toBe(ORIGIN);
  });

  test("confirmEmail returns true on the confirmation page", async () => {
    const session = mockSession(() => ({
      status: 200,
      body: "Your email has been confirmed and your registration is now complete.",
    }));
    const client = new BhwClient({ session });
    expect(await client.confirmEmail("https://www.blackhatworld.com/account-confirmation/u.1/email?c=x")).toBe(true);
  });

  test("confirmEmail returns false on unrelated pages", async () => {
    const session = mockSession(() => ({ status: 200, body: "Some error page" }));
    const client = new BhwClient({ session });
    expect(await client.confirmEmail("https://www.blackhatworld.com/account-confirmation/u.1/email?c=x")).toBe(false);
  });

  test("search delegates to BHW's standard results endpoint", async () => {
    const session = mockSession((url, init) => {
      if (init?.method === undefined) {
        expect(url.pathname).toBe("/search/search");
        return {
          status: 200,
          body: `
            <form action="/search/search" method="post">
              <input type="hidden" name="_xfToken" value="1700000000,abc123">
              <input name="keywords">
              <select name="order"><option value="date" selected>Date</option></select>
            </form>`,
        };
      }
      expect(url.pathname).toBe("/search/search");
      expect(init?.method).toBe("POST");
      return {
        status: 200,
        body: `
          <input type="hidden" name="_xfToken" value="1700000000,abc123">
          <div class="structItem structItem--thread js-threadListItem-99">
            <div class="structItem-title"><a href="/seo/linkedin-outreach.99/">LinkedIn outreach</a></div>
          </div>`,
        url: "https://www.blackhatworld.com/search/43610234/?q=linkedin+outreach&o=date",
      };
    });
    const client = new BhwClient({ session });
    const page = await client.search("linkedin outreach");
    expect(page.items[0]!.threadId).toBe(99);
    expect(client.xfToken).toBe("1700000000,abc123");
  });

  test("requests auto-clear Cloudflare challenges when a solver is set", async () => {
    let fetches = 0;
    const jar: Record<string, string> = {};
    const base = mockSession(() => {
      fetches += 1;
      return fetches === 1
        ? { status: 403, body: "<title>Just a moment...</title>" }
        : { status: 200, body: `<input type="hidden" name="_xfToken" value="1700000000,abc123">` };
    });
    const session = {
      ...base,
      setCookie(name: string, value: string): void {
        jar[name] = value;
      },
    };
    const client = new BhwClient({
      session,
      captchaSolver: {
        async solve() {
          return {
            type: "cloudflare-waf" as const,
            clearance: "clr_abc",
            cfBm: null,
            cfRt: null,
            headers: {},
            attributes: {},
          };
        },
      },
    });
    const token = await client.ensureToken();
    expect(token).toBe("1700000000,abc123");
    expect(fetches).toBe(2);
    expect(jar.cf_clearance).toBe("clr_abc");
  });
});
