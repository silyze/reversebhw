import { describe, test, expect } from "bun:test";

import {
  BhwThreadError,
  parseBhwThreadPage,
} from "../src/thread.js";

function threadPageHtml(opts: {
  title?: string;
  forumName?: string;
  posts?: Array<{
    postId: number;
    author: string;
    authorId: number;
    date: number;
    messageHtml: string;
    reactionScore?: number;
  }>;
  attachmentHash?: string;
  postCount?: string;
  viewCount?: string;
} = {}): string {
  const {
    title = "Test Thread Title",
    forumName = "Black Hat SEO",
    posts = [
      {
        postId: 12345,
        author: "testuser",
        authorId: 67890,
        date: 1700000000,
        messageHtml: "Hello <b>world</b>",
        reactionScore: 5,
      },
    ],
    attachmentHash = "attach_hash_abc",
    postCount = "1",
    viewCount = "100",
  } = opts;

  const postHtml = posts
    .map(
      (p) => `
    <article class="message" data-content="post-${p.postId}" data-author="${p.author}">
      <div class="message-name">
        <a class="username" href="/members/${p.author}.${p.authorId}/" data-user-id="${p.authorId}">${p.author}</a>
      </div>
      <div class="message-attribution-main">
        <a href="/seo/test-thread.999/post-${p.postId}"><time class="u-dt" data-time="${p.date}">Nov 15, 2023</time></a>
      </div>
      <div class="message-body">
        <div class="bbWrapper">${p.messageHtml}</div>
      </div>
      <div class="js-reactionList" data-reaction-score="${p.reactionScore ?? 0}"></div>
    </article>`,
    )
    .join("\n");

  return `
  <html><head><title>${title}</title></head><body>
  <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
  <input type="hidden" name="attachment_hash" value="${attachmentHash}">
  <h1 class="p-title-value">${title}</h1>
  <span class="crumb"><a href="#">BlackHatWorld</a></span>
  <span class="crumb"><a href="#">${forumName}</a></span>
  <div class="block-outer">
    <dl class="pairs"><dt>Replies</dt><dd>${postCount}</dd></dl>
    <dl class="pairs"><dt>Views</dt><dd>${viewCount}</dd></dl>
  </div>
  ${postHtml}
  </body></html>`;
}

describe("parseBhwThreadPage", () => {
  test("extracts thread metadata", () => {
    const page = parseBhwThreadPage(threadPageHtml(), 999, "test-thread");
    expect(page.thread.threadId).toBe(999);
    expect(page.thread.slug).toBe("test-thread");
    expect(page.thread.title).toBe("Test Thread Title");
    expect(page.thread.forumName).toBe("Black Hat SEO");
  });

  test("extracts xfToken and attachmentHash", () => {
    const page = parseBhwThreadPage(threadPageHtml(), 1, "slug");
    expect(page.xfToken).toBe("1700000000,abc123def456");
    expect(page.attachmentHash).toBe("attach_hash_abc");
  });

  test("recognizes an enabled quick-reply form", () => {
    const html = threadPageHtml() + `
      <form class="js-quickReply" action="/seo/test-thread.999/add-reply">
        <textarea name="message"></textarea>
      </form>`;
    const page = parseBhwThreadPage(html, 999, "test-thread");
    expect(page.canReply).toBe(true);
    expect(page.replyAction).toBe("/seo/test-thread.999/add-reply");
  });

  test("does not mark a closed thread as replyable", () => {
    const html = threadPageHtml() + `
      <form class="js-quickReply" action="/threads/test-thread.999/add-reply">
        <textarea name="message"></textarea>
      </form>
      <div class="blockMessage--important">This thread is closed for further replies.</div>`;
    expect(parseBhwThreadPage(html, 999, "test-thread").canReply).toBe(false);
  });

  test("parses posts with all fields", () => {
    const page = parseBhwThreadPage(threadPageHtml(), 999, "slug");
    expect(page.posts).toHaveLength(1);
    const post = page.posts[0]!;
    expect(post.postId).toBe(12345);
    expect(post.author).toBe("testuser");
    expect(post.authorId).toBe(67890);
    expect(post.date).toBe(1700000000);
    expect(post.messageHtml).toBe("Hello <b>world</b>");
    expect(post.reactionScore).toBe(5);
    expect(post.threadId).toBe(999);
  });

  test("parses multiple posts", () => {
    const html = threadPageHtml({
      posts: [
        {
          postId: 1,
          author: "alice",
          authorId: 100,
          date: 1700000000,
          messageHtml: "first",
        },
        {
          postId: 2,
          author: "bob",
          authorId: 200,
          date: 1700000001,
          messageHtml: "second",
        },
      ],
    });
    const page = parseBhwThreadPage(html, 42, "slug");
    expect(page.posts).toHaveLength(2);
    expect(page.posts[0]!.author).toBe("alice");
    expect(page.posts[1]!.author).toBe("bob");
  });

  test("extracts post and view counts from block-outer", () => {
    const html = threadPageHtml({ postCount: "42", viewCount: "1,337" });
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.thread.postCount).toBe(42);
    expect(page.thread.viewCount).toBe(1337);
  });

  test("falls back to posts.length when block-outer missing", () => {
    const html = threadPageHtml().replace(
      /<div class="block-outer">[\s\S]*?<\/div>/,
      "",
    );
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.thread.postCount).toBe(1);
  });

  test("skips elements without data-content or data-message-id", () => {
    const html = `
      <html><body>
      <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
      <article class="message">
        <div class="message-content"><div class="bbWrapper">no id</div></div>
      </article>
      </body></html>
    `;
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.posts).toHaveLength(0);
  });

  test("uses data-author fallback when username link missing", () => {
    const html = `
      <html><body>
      <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
      <article class="message" data-content="post-99" data-author="ghost">
        <div class="message-content"><div class="bbWrapper">hi</div></div>
      </article>
      </body></html>
    `;
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.posts[0]!.author).toBe("ghost");
  });

  test("parses permalink from the attribution link", () => {
    const page = parseBhwThreadPage(threadPageHtml(), 999, "slug");
    expect(page.posts[0]!.permalink).toBe("/seo/test-thread.999/post-12345");
  });

  test("single-page thread reports pagination 1 of 1 with no links", () => {
    const page = parseBhwThreadPage(threadPageHtml(), 999, "slug");
    expect(page.pagination).toEqual({ currentPage: 1, totalPages: 1 });
  });

  test("parses pageNav current/total and next/last links", () => {
    const html =
      threadPageHtml() +
      `
      <div class="pageNavWrapper">
        <a class="pageNav-page" href="/seo/test-thread.999/">1</a>
        <a class="pageNav-page" href="/seo/test-thread.999/page-2">2</a>
        <a class="pageNav-jump pageNav-jump--next" href="/seo/test-thread.999/page-2">Next</a>
        <div class="pageNavSimple">
          <span class="pageNavSimple-el pageNavSimple-el--current">1 of 3</span>
          <a class="pageNavSimple-el pageNavSimple-el--next" href="/seo/test-thread.999/page-2">Next</a>
          <a class="pageNavSimple-el pageNavSimple-el--last" href="/seo/test-thread.999/page-3">Last</a>
        </div>
      </div>`;
    const page = parseBhwThreadPage(html, 999, "test-thread");
    expect(page.pagination.currentPage).toBe(1);
    expect(page.pagination.totalPages).toBe(3);
    expect(page.pagination.nextPageUrl).toBe("/seo/test-thread.999/page-2");
    expect(page.pagination.lastPageUrl).toBe("/seo/test-thread.999/page-3");
  });

  test("counts reactionSummary items when no score attribute exists", () => {
    const html = `
      <html><body>
      <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
      <article class="message" data-content="post-5" data-author="op">
        <div class="message-name"><a href="/members/op.9/">op</a></div>
        <div class="message-body"><div class="bbWrapper">hi</div></div>
        <div class="reactionsBar js-reactionsList is-active">
          <ul class="reactionSummary">
            <li><span class="reaction" data-reaction-id="1"></span></li>
          </ul>
          <a class="reactionsBar-link"><bdi>TestUser</bdi></a>
        </div>
      </article>
      </body></html>
    `;
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.posts[0]!.reactionScore).toBe(1);
  });

  test("parses ISO datetime with uncolonated offset", () => {
    const html = `
      <html><body>
      <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
      <article class="message" data-content="post-7" data-author="tz">
        <div class="message-name"><a href="/members/tz.5/">tz</a></div>
        <div class="message-body"><div class="bbWrapper">hi</div></div>
        <time datetime="2026-08-02T20:07:33+0100">Aug 2, 2026</time>
      </article>
      </body></html>
    `;
    const page = parseBhwThreadPage(html, 1, "slug");
    expect(page.posts[0]!.date).toBe(
      Math.floor(Date.parse("2026-08-02T20:07:33+01:00") / 1000),
    );
  });

  test("last page has no next link", () => {
    const html =
      threadPageHtml() +
      `
      <div class="pageNavWrapper">
        <div class="pageNavSimple">
          <span class="pageNavSimple-el pageNavSimple-el--current">3 of 3</span>
          <a class="pageNavSimple-el pageNavSimple-el--first" href="/seo/test-thread.999/">First</a>
        </div>
      </div>`;
    const page = parseBhwThreadPage(html, 999, "test-thread");
    expect(page.pagination.currentPage).toBe(3);
    expect(page.pagination.totalPages).toBe(3);
    expect(page.pagination.nextPageUrl).toBeUndefined();
  });
});
