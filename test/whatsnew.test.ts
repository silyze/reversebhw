import { describe, test, expect } from "bun:test";

import { parseBhwWhatsNewPage } from "../src/whatsnew.js";

function feedItemHtml(item: {
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
}): string {
  return `
  <div class="structItem structItem--thread js-inlineModContainer js-threadListItem-${item.threadId}" data-author="${item.author}">
    <div class="structItem-cell structItem-cell--icon">
      <div class="structItem-iconContainer">
        <a href="/members/${item.author.toLowerCase().replace(/ /g, "-")}.${item.authorId}/" class="avatar" data-user-id="${item.authorId}"></a>
      </div>
    </div>
    <div class="structItem-cell structItem-cell--main">
      <div class="structItem-title">
        <a href="/seo/${item.slug}.${item.threadId}/">${item.title}</a>
      </div>
      <div class="structItem-minor">
        <a href="/members/${item.author.toLowerCase().replace(/ /g, "-")}.${item.authorId}/">${item.author}</a>
        <span class="structItem-startDate"><time datetime="${item.started}">Today</time></span>
        <a href="/forums/${item.forumName.toLowerCase().replace(/ /g, "-")}.${item.forumId}/">${item.forumName}</a>
      </div>
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

const ITEM_A = {
  threadId: 1839236,
  slug: "are-youtube-live-streams-still-effective",
  title: "Are YouTube Live Streams Still Effective?",
  author: "Mason Bradford",
  authorId: 2360652,
  forumName: "YouTube",
  forumId: 77,
  lastPoster: "Dior Dominguez",
  lastPosterId: 1987184,
  replies: 3,
  views: 44,
  started: "2026-08-09T08:05:20+0100",
  latest: "2026-08-09T10:41:52+0100",
};

function feedHtml(items: string[], nav = ""): string {
  return `
  <html><body>
  <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
  ${items.join("\n")}
  ${nav}
  </body></html>`;
}

describe("parseBhwWhatsNewPage", () => {
  test("parses a feed item with all fields", () => {
    const page = parseBhwWhatsNewPage(feedHtml([feedItemHtml(ITEM_A)]), 5754907);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.threadId).toBe(1839236);
    expect(item.title).toBe("Are YouTube Live Streams Still Effective?");
    expect(item.slug).toBe("are-youtube-live-streams-still-effective");
    expect(item.url).toBe("/seo/are-youtube-live-streams-still-effective.1839236/");
    expect(item.forumName).toBe("YouTube");
    expect(item.forumUrl).toBe("/forums/youtube.77/");
    expect(item.author).toBe("Mason Bradford");
    expect(item.authorId).toBe(2360652);
    expect(item.lastPoster).toBe("Dior Dominguez");
    expect(item.lastPosterId).toBe(1987184);
    expect(item.replyCount).toBe(3);
    expect(item.viewCount).toBe(44);
    expect(item.startedAt).toBe(
      Math.floor(Date.parse("2026-08-09T08:05:20+01:00") / 1000),
    );
    expect(item.lastPostAt).toBe(
      Math.floor(Date.parse("2026-08-09T10:41:52+01:00") / 1000),
    );
  });

  test("falls back to js-threadListItem class for the id", () => {
    const html = feedHtml([
      feedItemHtml(ITEM_A).replace(
        'href="/seo/are-youtube-live-streams-still-effective.1839236/"',
        'href=""',
      ),
    ]);
    const page = parseBhwWhatsNewPage(html);
    expect(page.items[0]!.threadId).toBe(1839236);
    expect(page.items[0]!.slug).toBe("");
  });

  test("skips rows without a resolvable thread id", () => {
    const html = feedHtml([
      `<div class="structItem structItem--thread" data-author="x">
        <div class="structItem-title"><a>no href</a></div>
      </div>`,
    ]);
    const page = parseBhwWhatsNewPage(html);
    expect(page.items).toHaveLength(0);
  });

  test("carries the resultSetId and xfToken through", () => {
    const page = parseBhwWhatsNewPage(feedHtml([feedItemHtml(ITEM_A)]), 123);
    expect(page.resultSetId).toBe(123);
    expect(page.xfToken).toBe("1700000000,abc123def456");
  });

  test("parses the 10-page feed nav", () => {
    const nav = `
      <div class="pageNavWrapper">
        <a class="pageNav-jump pageNav-jump--next" href="/whats-new/posts/5754907/page-2">Next</a>
        <div class="pageNavSimple">
          <span class="pageNavSimple-el pageNavSimple-el--current">1 of 10</span>
          <a class="pageNavSimple-el pageNavSimple-el--last" href="/whats-new/posts/5754907/page-10">Last</a>
        </div>
      </div>`;
    const page = parseBhwWhatsNewPage(feedHtml([feedItemHtml(ITEM_A)], nav));
    expect(page.pagination.currentPage).toBe(1);
    expect(page.pagination.totalPages).toBe(10);
    expect(page.pagination.nextPageUrl).toBe("/whats-new/posts/5754907/page-2");
    expect(page.pagination.lastPageUrl).toBe("/whats-new/posts/5754907/page-10");
  });
});
