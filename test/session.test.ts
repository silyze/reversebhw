import { describe, test, expect } from "bun:test";

import {
  createBhwSession,
  normalizeBhwProxy,
  parseCookieString,
} from "../src/session.js";

describe("parseCookieString", () => {
  test("parses a document.cookie style string", () => {
    expect(parseCookieString("xf_session=abc123; cf_clearance=xyz.789")).toEqual([
      { name: "xf_session", value: "abc123" },
      { name: "cf_clearance", value: "xyz.789" },
    ]);
  });

  test("keeps = signs inside values", () => {
    expect(parseCookieString("token=a=b=c")).toEqual([
      { name: "token", value: "a=b=c" },
    ]);
  });

  test("skips empty and malformed segments", () => {
    expect(parseCookieString(" ; noequals; =noval; good=1")).toEqual([
      { name: "good", value: "1" },
    ]);
  });
});

describe("createBhwSession cookies", () => {
  test("seeds the jar from an array", async () => {
    const session = await createBhwSession({
      cookies: [
        { name: "xf_session", value: "seeded1" },
        { name: "xf_csrf", value: "seeded2" },
      ],
    });
    try {
      expect(session.getCookies?.()).toMatchObject({
        xf_session: "seeded1",
        xf_csrf: "seeded2",
      });
    } finally {
      await session.close();
    }
  });

  test("seeds the jar from a header string", async () => {
    const session = await createBhwSession({
      cookies: "xf_session=str1; cf_clearance=str2",
    });
    try {
      expect(session.getCookies?.()).toMatchObject({
        xf_session: "str1",
        cf_clearance: "str2",
      });
    } finally {
      await session.close();
    }
  });
});

describe("normalizeBhwProxy", () => {
  test("adds http:// to bare host:port", () => {
    expect(normalizeBhwProxy("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  });

  test("preserves an existing http:// scheme", () => {
    expect(normalizeBhwProxy("http://proxy.local:3128")).toBe(
      "http://proxy.local:3128/",
    );
  });

  test("preserves an existing https:// scheme", () => {
    expect(normalizeBhwProxy("https://secure.proxy:443")).toBe(
      "https://secure.proxy/",
    );
  });

  test("preserves socks5:// scheme", () => {
    expect(normalizeBhwProxy("socks5://proxy:1080")).toBe("socks5://proxy:1080");
  });

  test("accepts a URL object", () => {
    expect(normalizeBhwProxy(new URL("http://localhost:9999"))).toBe(
      "http://localhost:9999/",
    );
  });

  test("preserves auth credentials in the href", () => {
    expect(normalizeBhwProxy("user:pass@proxy:8080")).toBe(
      "http://user:pass@proxy:8080/",
    );
  });
});
