import { describe, expect, test } from "bun:test";

import {
  BhwSearchError,
  fetchBhwSearch,
  parseBhwSearchPage,
} from "../src/search.js";
import type {
  BhwFetchInit,
  BhwFetchResponse,
  BhwFetchTransport,
} from "../src/session.js";

const ORIGIN = new URL("https://www.blackhatworld.com/");
const TOKEN = "1700000000,abc123def456";

function searchItemHtml(overrides: Partial<{
  threadId: number;
  slug: string;
  title: string;
  author: string;
  authorId: number;
  forumName: string;
  forumId: number;
  lastPoster: string;
  lastPosterId: number;
  replies: number;
  views: number;
  started: string;
  latest: string;
  excerpt: string;
}> = {}): string {
  const item = {
    threadId: 1839236,
    slug: "how-to-coordinate-linkedin-and-email",
    title: "How do you coordinate LinkedIn and cold email?",
    author: "Mason Bradford",
    authorId: 2360652,
    forumName: "Lead Generation",
    forumId: 86,
    lastPoster: "Dior Dominguez",
    lastPosterId: 1987184,
    replies: 3,
    views: 44,
    started: "2026-08-09T08:05:20+0100",
    latest: "2026-08-09T10:41:52+0100",
    excerpt: "I am trying to avoid overlapping outreach messages.",
    ...overrides,
  };

  return `
    <div class="structItem structItem--thread js-threadListItem-${item.threadId}" data-author="${item.author}">
      <div class="structItem-cell structItem-cell--main">
        <div class="structItem-title">
          <a href="/seo/${item.slug}.${item.threadId}/">${item.title}</a>
        </div>
        <div class="structItem-minor">
          <a href="/members/${item.author.toLowerCase().replace(/ /g, "-")}.${item.authorId}/">${item.author}</a>
          <span class="structItem-startDate"><time datetime="${item.started}">Today</time></span>
          <a href="/forums/lead-generation.${item.forumId}/">${item.forumName}</a>
        </div>
        <div class="structItem-snippet">${item.excerpt}</div>
      </div>
      <div class="structItem-cell structItem-cell--meta">
        <dl class="pairs"><dt>Replies</dt><dd>${item.replies}</dd></dl>
        <dl class="pairs"><dt>Views</dt><dd>${item.views}</dd></dl>
      </div>
      <div class="structItem-cell structItem-cell--latest">
        <a href="/members/${item.lastPoster.toLowerCase().replace(/ /g, "-")}.${item.lastPosterId}/">${item.lastPoster}</a>
        <time datetime="${item.latest}">A moment ago</time>
      </div>
    </div>`;
}

function searchHtml(items: string[], nav = ""): string {
  return `
    <html><body>
      <form><input type="hidden" name="_xfToken" value="${TOKEN}"></form>
      ${items.join("\n")}
      ${nav}
    </body></html>`;
}

function mockTransport(
  handler: (url: URL, init?: BhwFetchInit) => { status?: number; body: string; url?: string },
): { transport: BhwFetchTransport; calls: Array<{ url: URL; init?: BhwFetchInit }> } {
  const calls: Array<{ url: URL; init?: BhwFetchInit }> = [];
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
          text: async () => result.body,
          json: async () => JSON.parse(result.body),
        };
      },
    },
  };
}

describe("parseBhwSearchPage", () => {
  test("parses thread search rows and their discovery metadata", () => {
    const page = parseBhwSearchPage(searchHtml([searchItemHtml()]));
    expect(page.xfToken).toBe(TOKEN);
    expect(page.items).toHaveLength(1);

    const item = page.items[0]!;
    expect(item.threadId).toBe(1839236);
    expect(item.slug).toBe("how-to-coordinate-linkedin-and-email");
    expect(item.url).toBe(
      "/seo/how-to-coordinate-linkedin-and-email.1839236/",
    );
    expect(item.title).toBe("How do you coordinate LinkedIn and cold email?");
    expect(item.forumName).toBe("Lead Generation");
    expect(item.forumUrl).toBe("/forums/lead-generation.86/");
    expect(item.author).toBe("Mason Bradford");
    expect(item.authorId).toBe(2360652);
    expect(item.lastPoster).toBe("Dior Dominguez");
    expect(item.lastPosterId).toBe(1987184);
    expect(item.replyCount).toBe(3);
    expect(item.viewCount).toBe(44);
    expect(item.excerpt).toBe(
      "I am trying to avoid overlapping outreach messages.",
    );
    expect(item.startedAt).toBe(
      Math.floor(Date.parse("2026-08-09T08:05:20+01:00") / 1000),
    );
    expect(item.lastPostAt).toBe(
      Math.floor(Date.parse("2026-08-09T10:41:52+01:00") / 1000),
    );
  });

  test("uses the row id when the title URL is unavailable", () => {
    const html = searchHtml([
      searchItemHtml().replace(
        "/seo/how-to-coordinate-linkedin-and-email.1839236/",
        "",
      ),
    ]);
    const page = parseBhwSearchPage(html);
    expect(page.items[0]!.threadId).toBe(1839236);
    expect(page.items[0]!.slug).toBe("");
  });

  test("parses XenForo pagination", () => {
    const nav = `
      <div class="pageNavWrapper">
        <a class="pageNav-jump pageNav-jump--next" href="/search/123/page-2">Next</a>
        <div class="pageNavSimple">
          <span class="pageNavSimple-el pageNavSimple-el--current">1 of 3</span>
          <a class="pageNavSimple-el pageNavSimple-el--last" href="/search/123/page-3">Last</a>
        </div>
      </div>`;
    const page = parseBhwSearchPage(searchHtml([searchItemHtml()], nav));
    expect(page.pagination).toEqual({
      currentPage: 1,
      totalPages: 3,
      nextPageUrl: "/search/123/page-2",
      lastPageUrl: "/search/123/page-3",
    });
  });
});

describe("fetchBhwSearch", () => {
  test("submits BHW's normal search form and parses the redirected results page", async () => {
    const { transport, calls } = mockTransport((url, init) => {
      expect(url.pathname).toBe("/search/search");
      expect(init?.method).toBe("POST");
      expect(init?.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(init?.body?.toString()).toContain("keywords=linkedin+outreach");
      expect(init?.body?.toString()).toContain("c%5Bcontent%5D=thread");
      expect(init?.body?.toString()).toContain("order=date");
      expect(init?.body?.toString()).toContain(`_xfToken=${encodeURIComponent(TOKEN)}`);
      return {
        body: searchHtml([searchItemHtml()]),
        url: "https://www.blackhatworld.com/search/43610234/?q=linkedin+outreach&o=date",
      };
    });
    const page = await fetchBhwSearch(transport, ORIGIN, "linkedin outreach", {}, TOKEN);

    expect(page.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/search/search");
    expect(calls[0]!.init?.headers?.accept).toBe("text/html");
  });

  test("rejects a Cloudflare challenge without attempting a solver", async () => {
    const { transport } = mockTransport(() => ({
      status: 403,
      body: "<html><title>Just a moment...</title></html>",
    }));

    await expect(
      fetchBhwSearch(transport, ORIGIN, "linkedin outreach"),
    ).rejects.toThrow(BhwSearchError);
  });

  test("rejects empty keywords before making a request", async () => {
    const { transport, calls } = mockTransport(() => ({ body: "" }));
    await expect(fetchBhwSearch(transport, ORIGIN, "  ")).rejects.toThrow(
      "Search keywords must not be empty",
    );
    expect(calls).toHaveLength(0);
  });

  test("uses a requested positive results page", async () => {
    const { transport, calls } = mockTransport((url) => {
      if (url.pathname === "/search/search") {
        return {
          body: searchHtml([searchItemHtml()]),
          url: "https://www.blackhatworld.com/search/43610234/?q=linkedin+outreach&o=date",
        };
      }
      return { body: searchHtml([searchItemHtml()]) };
    });
    await fetchBhwSearch(transport, ORIGIN, "linkedin outreach", { page: 2 }, TOKEN);
    expect(calls[1]!.url.pathname).toBe("/search/43610234/page-2");
  });

  test("parses BHW's alternate search-result rows", () => {
    const page = parseBhwSearchPage(`
      <html><body>
        <input type="hidden" name="_xfToken" value="${TOKEN}">
        <div class="searchResult">
          <h3 class="title"><a href="/linkedin/linkedin-outreach.1848402/">LinkedIn Outreach</a></h3>
          <div class="meta"><a href="/linkedin/">Linkedin</a></div>
        </div>
      </body></html>`);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      threadId: 1848402,
      slug: "linkedin-outreach",
      title: "LinkedIn Outreach",
    });
  });

  test("rejects invalid result pages before making a request", async () => {
    const { transport, calls } = mockTransport(() => ({ body: "" }));
    await expect(fetchBhwSearch(transport, ORIGIN, "linkedin outreach", { page: 0 })).rejects.toThrow(
      "Search page must be a positive integer",
    );
    expect(calls).toHaveLength(0);
  });
});
