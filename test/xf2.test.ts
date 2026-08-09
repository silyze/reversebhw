import { describe, test, expect } from "bun:test";

import {
  XF_AJAX_HEADERS,
  XfProtocolError,
  extractXfToken,
  parseXfJson,
  xfAjaxParams,
  xfErrorMessage,
  xfHasError,
} from "../src/xf2.js";

describe("extractXfToken", () => {
  test("extracts a valid token from a hidden input", () => {
    const html = `<input type="hidden" name="_xfToken" value="1700000000,a1b2c3d4e5f6a7b8">`;
    expect(extractXfToken(html)).toBe("1700000000,a1b2c3d4e5f6a7b8");
  });

  test("extracts token from the first match when multiple exist", () => {
    const html = `
      <input type="hidden" name="_xfToken" value="111,aaaaaaaaaaaa">
      <input type="hidden" name="_xfToken" value="222,bbbbbbbbbbbb">
    `;
    expect(extractXfToken(html)).toBe("111,aaaaaaaaaaaa");
  });

  test("throws XfProtocolError when token is absent", () => {
    expect(() => extractXfToken("<html><body>no token here</body></html>")).toThrow(
      XfProtocolError,
    );
  });

  test("throws when value does not match the timestamp,hash pattern", () => {
    const html = `<input type="hidden" name="_xfToken" value="garbage">`;
    expect(() => extractXfToken(html)).toThrow(XfProtocolError);
  });

  test("throws on Cloudflare challenge page", () => {
    expect(() =>
      extractXfToken("<html><body>Just a moment...</body></html>"),
    ).toThrow(XfProtocolError);
  });
});

describe("parseXfJson", () => {
  test("returns an object body unchanged", () => {
    const body = { status: "ok", data: 42 };
    expect(parseXfJson(body)).toBe(body);
  });

  test("throws on null", () => {
    expect(() => parseXfJson(null)).toThrow(XfProtocolError);
  });

  test("throws on array", () => {
    expect(() => parseXfJson([1, 2, 3])).toThrow(XfProtocolError);
  });

  test("throws on primitive", () => {
    expect(() => parseXfJson("string")).toThrow(XfProtocolError);
  });
});

describe("xfHasError", () => {
  test("true when status is error", () => {
    expect(xfHasError({ status: "error" })).toBe(true);
  });

  test("false when status is ok", () => {
    expect(xfHasError({ status: "ok" })).toBe(false);
  });

  test("false when status key is absent", () => {
    expect(xfHasError({})).toBe(false);
  });
});

describe("xfErrorMessage", () => {
  test("joins array of errors with semicolons", () => {
    expect(
      xfErrorMessage({ status: "error", errors: ["Username taken", "Email invalid"] }),
    ).toBe("Username taken; Email invalid");
  });

  test("returns fallback for empty errors array", () => {
    expect(xfErrorMessage({ status: "error", errors: [] })).toBe(
      'unknown XF2 error: {"status":"error","errors":[]}',
    );
  });

  test("returns fallback when errors key is absent", () => {
    expect(xfErrorMessage({ status: "error" })).toBe(
      'unknown XF2 error: {"status":"error"}',
    );
  });

  test("reads the message field when no errors array is present", () => {
    expect(
      xfErrorMessage({ status: "error", message: "Email address is in use" }),
    ).toBe("Email address is in use");
  });

  test("strips HTML from errorHtml content", () => {
    expect(
      xfErrorMessage({
        status: "error",
        errorHtml: { content: '<div class="blockMessage">Nope.</div>' },
      }),
    ).toBe("Nope.");
  });
});

describe("xfAjaxParams", () => {
  test("builds the XF2 AJAX envelope", () => {
    const params = xfAjaxParams("123,abc", "/threads/foo.123/");
    expect(params).toEqual({
      _xfToken: "123,abc",
      _xfResponseType: "json",
      _xfWithData: 1,
      _xfRequestUri: "/threads/foo.123/",
    });
  });

  test("literal types are correct", () => {
    const params = xfAjaxParams("1,a", "/");
    expect(params._xfResponseType).toBe("json");
    expect(params._xfWithData).toBe(1);
  });
});

describe("XF_AJAX_HEADERS", () => {
  test("includes the X-Requested-With header", () => {
    expect(XF_AJAX_HEADERS["x-requested-with"]).toBe("XMLHttpRequest");
  });
});
