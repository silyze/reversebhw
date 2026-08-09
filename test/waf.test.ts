import { describe, test, expect } from "bun:test";

import {
  BhwWafError,
  clearCloudflareWaf,
  isCloudflareChallenge,
  wafResilientTransport,
} from "../src/waf.js";
import type {
  CaptchaChallenge,
  CaptchaSolution,
  CaptchaSolver,
  CloudflareWafChallenge,
} from "../src/captcha.js";
import type {
  BhwFetchInit,
  BhwFetchResponse,
  BhwSession,
} from "../src/session.js";

const ORIGIN = "https://www.blackhatworld.com/";
const CHALLENGE_HTML =
  "<html><title>Just a moment...</title>Enable JavaScript and cookies to continue</html>";

function mockSolver(
  onSolve?: (challenge: CaptchaChallenge) => void,
): CaptchaSolver & { calls: CaptchaChallenge[] } {
  const calls: CaptchaChallenge[] = [];
  return {
    calls,
    async solve(challenge: CaptchaChallenge): Promise<CaptchaSolution> {
      calls.push(challenge);
      onSolve?.(challenge);
      return {
        type: "cloudflare-waf",
        clearance: "clr_test_123",
        cfBm: null,
        cfRt: "rt_test",
        headers: {},
        attributes: {},
      };
    },
  };
}

function mockSession(
  handler: (url: string) => { status: number; body: string },
): BhwSession & { jar: Record<string, string> } {
  const jar: Record<string, string> = {};
  return {
    origin: new URL(ORIGIN),
    config: { browser: "chrome_131", os: "windows", proxy: "http://proxy.test" },
    jar,
    setCookie(name: string, value: string): void {
      jar[name] = value;
    },
    getCookies(): Record<string, string> {
      return { ...jar };
    },
    async fetch(url: string | URL, _init?: BhwFetchInit): Promise<BhwFetchResponse> {
      const resolved = url instanceof URL ? url.href : url;
      const result = handler(resolved);
      return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        url: resolved,
        text: () => Promise.resolve(result.body),
        json: () => Promise.resolve(JSON.parse(result.body)),
      };
    },
    async close(): Promise<void> {},
  };
}

describe("isCloudflareChallenge", () => {
  test("detects the interstitial on 403", () => {
    expect(isCloudflareChallenge(403, CHALLENGE_HTML)).toBe(true);
  });

  test("ignores challenge text on non-403 status", () => {
    expect(isCloudflareChallenge(200, CHALLENGE_HTML)).toBe(false);
  });

  test("ignores ordinary 403 bodies", () => {
    expect(isCloudflareChallenge(403, "Forbidden")).toBe(false);
  });
});

describe("clearCloudflareWaf", () => {
  test("applies clearance cookies from the solver", async () => {
    const session = mockSession(() => ({ status: 200, body: "ok" }));
    const solver = mockSolver();
    await clearCloudflareWaf(session, solver);
    expect(session.jar.cf_clearance).toBe("clr_test_123");
    expect(session.jar.__cf_bm).toBeUndefined(); // cfBm null → not set
  });

  test("sends the session proxy and emulated UA with the challenge", async () => {
    const session = mockSession(() => ({ status: 200, body: "ok" }));
    const solver = mockSolver();
    await clearCloudflareWaf(session, solver);
    const challenge = solver.calls[0] as CloudflareWafChallenge;
    expect(challenge.type).toBe("cloudflare-waf");
    expect(challenge.proxy).toBe("http://proxy.test");
    expect(challenge.userAgent).toContain("Chrome/");
  });

  test("throws when the session cannot store cookies", async () => {
    const session = mockSession(() => ({ status: 200, body: "ok" }));
    const { setCookie: _drop, ...noCookies } = session;
    await expect(
      clearCloudflareWaf(noCookies, mockSolver()),
    ).rejects.toThrow(BhwWafError);
  });
});

describe("wafResilientTransport", () => {
  test("passes clean responses through without invoking the solver", async () => {
    const session = mockSession(() => ({ status: 200, body: "hello" }));
    const solver = mockSolver();
    const transport = wafResilientTransport(session, solver);
    const res = await transport.fetch(ORIGIN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(solver.calls.length).toBe(0);
  });

  test("solves the challenge and retries the original request", async () => {
    let fetches = 0;
    const session = mockSession(() => {
      fetches += 1;
      return fetches === 1
        ? { status: 403, body: CHALLENGE_HTML }
        : { status: 200, body: "cleared" };
    });
    const solver = mockSolver();
    const transport = wafResilientTransport(session, solver);
    const res = await transport.fetch(ORIGIN);
    expect(await res.text()).toBe("cleared");
    expect(fetches).toBe(2);
    expect(solver.calls.length).toBe(1);
    expect(session.jar.cf_clearance).toBe("clr_test_123");
  });

  test("retries flaky clearances up to maxAttempts then throws", async () => {
    const session = mockSession(() => ({ status: 403, body: CHALLENGE_HTML }));
    const solver = mockSolver();
    const transport = wafResilientTransport(session, solver, {
      maxAttempts: 2,
    });
    await expect(transport.fetch(ORIGIN)).rejects.toThrow(BhwWafError);
    expect(solver.calls.length).toBe(2);
  });

  test("non-challenge 403 bodies are returned, not retried", async () => {
    const session = mockSession(() => ({ status: 403, body: "Forbidden" }));
    const solver = mockSolver();
    const transport = wafResilientTransport(session, solver);
    const res = await transport.fetch(ORIGIN);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(solver.calls.length).toBe(0);
  });
});
