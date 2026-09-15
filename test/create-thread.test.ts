import { describe, expect, test } from "bun:test";

import {
  BhwThreadError,
  createBhwThread,
  fetchBhwThreadCreationForm,
  parseBhwThreadCreationForm,
} from "../src/index.js";
import type {
  BhwFetchInit,
  BhwFetchResponse,
  BhwFetchTransport,
} from "../src/session.js";

const ORIGIN = new URL("https://www.blackhatworld.com/");
const TOKEN = "1700000000,abc123def456";

type Call = {
  url: URL;
  init: BhwFetchInit | undefined;
};

function mockTransport(
  handler: (url: URL, init: BhwFetchInit | undefined) => {
    status?: number;
    url?: string;
    body: string;
  },
): { transport: BhwFetchTransport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      async fetch(url: string | URL, init?: BhwFetchInit): Promise<BhwFetchResponse> {
        const resolved = url instanceof URL ? url : new URL(url, ORIGIN);
        calls.push({ url: resolved, init });
        const result = handler(resolved, init);
        const status = result.status ?? 200;
        return {
          status,
          ok: status >= 200 && status < 300,
          url: result.url ?? resolved.href,
          async text() {
            return result.body;
          },
          async json() {
            return JSON.parse(result.body);
          },
        };
      },
    },
  };
}

function composerHtml(options: {
  action?: string;
  attachmentHash?: string;
  attachmentCombined?: string;
} = {}): string {
  const {
    action = "/seo/post-thread",
    attachmentHash = "composer-hash",
    attachmentCombined = '{"type":"post","context":{"node_id":42},"hash":"composer-hash"}',
  } = options;
  return `
    <html><body>
      <form action="${action}" method="post">
        <input type="hidden" name="_xfToken" value="${TOKEN}">
        <input type="hidden" name="node_id" value="42">
        <input type="hidden" name="attachment_hash" value="${attachmentHash}">
        <input type="hidden" name="attachment_hash_combined" value='${attachmentCombined}'>
        <input type="text" name="title" value="">
        <textarea name="message_html"></textarea>
      </form>
    </body></html>`;
}

describe("thread creation", () => {
  test("discovers a composer from a forum page, preserves its hidden fields, and submits it", async () => {
    const { transport, calls } = mockTransport((url, init) => {
      if (url.pathname === "/seo/" && init?.method === undefined) {
        return {
          body: '<a class="button--cta" href="/seo/post-thread">Post thread</a>',
        };
      }
      if (url.pathname === "/seo/post-thread" && init?.method === undefined) {
        return { body: composerHtml() };
      }
      if (url.pathname === "/seo/post-thread" && init?.method === "POST") {
        return {
          body: JSON.stringify({
            status: "ok",
            redirect: "/seo/my-new-thread.123456/",
          }),
        };
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.href}`);
    });

    const result = await createBhwThread(transport, ORIGIN, {
      forumUrl: "/seo/",
      title: "My new thread",
      messageHtml: "<p>Hello BHW</p>",
      attachmentHash: "replacement-hash",
    });

    expect(result).toEqual({
      threadId: 123456,
      redirect: "/seo/my-new-thread.123456/",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.pathname).toBe("/seo/");
    expect(calls[1]!.url.pathname).toBe("/seo/post-thread");
    expect(calls[2]!.init?.method).toBe("POST");
    expect(calls[2]!.init?.headers?.referer).toBe(
      "https://www.blackhatworld.com/seo/post-thread",
    );

    const body = calls[2]!.init?.body as FormData;
    expect(body.get("_xfToken")).toBe(TOKEN);
    expect(body.get("node_id")).toBe("42");
    expect(body.get("title")).toBe("My new thread");
    expect(body.get("message_html")).toBe("<p>Hello BHW</p>");
    expect(body.get("attachment_hash")).toBe("replacement-hash");
    expect(JSON.parse(String(body.get("attachment_hash_combined")))).toEqual({
      type: "post",
      context: { node_id: 42 },
      hash: "replacement-hash",
    });
    expect(body.get("_xfResponseType")).toBe("json");
    expect(body.get("_xfWithData")).toBe("1");
    expect(body.get("_xfRequestUri")).toBe("/seo/post-thread");
  });

  test("accepts a direct composer URL without refetching a forum page", async () => {
    const { transport, calls } = mockTransport(() => ({ body: composerHtml() }));

    const form = await fetchBhwThreadCreationForm(
      transport,
      ORIGIN,
      "/seo/post-thread",
    );

    expect(calls).toHaveLength(1);
    expect(form.composerUrl).toBe("https://www.blackhatworld.com/seo/post-thread");
    expect(form.actionUrl).toBe("https://www.blackhatworld.com/seo/post-thread");
    expect(form.xfToken).toBe(TOKEN);
    expect(form.hiddenFields.node_id).toBe("42");
  });

  test("rejects cross-origin forum and form URLs", () => {
    expect(() => parseBhwThreadCreationForm(
      composerHtml({ action: "https://example.com/post-thread" }),
      "/seo/post-thread",
      ORIGIN,
    )).toThrow(BhwThreadError);
  });

  test("fails cleanly when the forum has no composer link", async () => {
    const { transport } = mockTransport(() => ({ body: "<html><body>Forum</body></html>" }));

    await expect(createBhwThread(transport, ORIGIN, {
      forumUrl: "/seo/",
      title: "Title",
      messageHtml: "<p>Body</p>",
    })).rejects.toThrow("Could not find a new-thread composer link");
  });

  test("surfaces XF validation errors without treating them as a created thread", async () => {
    const { transport } = mockTransport((url, init) => {
      if (init?.method === undefined) return { body: composerHtml() };
      if (url.pathname === "/seo/post-thread" && init.method === "POST") {
        return { body: JSON.stringify({ status: "error", errors: ["Title is required"] }) };
      }
      throw new Error("Unexpected request");
    });

    await expect(createBhwThread(transport, ORIGIN, {
      forumUrl: "/seo/post-thread",
      title: "Title",
      messageHtml: "<p>Body</p>",
    })).rejects.toThrow("New thread rejected: Title is required");
  });
});
