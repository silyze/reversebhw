import { load } from "cheerio/slim";

import {
  extractXfToken,
  parseXfDate,
  parseXfPagination,
  type BhwPagination,
} from "./xf2.js";
import type { BhwFetchTransport } from "./session.js";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/** One row in BHW's "What's new → posts" feed (a recently bumped thread). */
export interface BhwFeedItem {
  readonly threadId: number;
  readonly title: string;
  /** Canonical thread slug from the title link. */
  readonly slug: string;
  /** Relative thread URL, e.g. `/seo/slug.123/`. */
  readonly url: string;
  readonly forumName: string;
  readonly forumUrl: string;
  /** Thread starter. */
  readonly author: string;
  readonly authorId: number;
  /** Unix timestamp of the thread's first post. */
  readonly startedAt: number;
  /** Author of the latest post. */
  readonly lastPoster: string;
  readonly lastPosterId: number;
  /** Unix timestamp of the latest post. */
  readonly lastPostAt: number;
  readonly replyCount: number;
  readonly viewCount: number;
}

export interface BhwWhatsNewPage {
  readonly items: readonly BhwFeedItem[];
  readonly pagination: BhwPagination;
  /**
   * Rotating result-set id embedded in the feed URL. Required to fetch
   * pages beyond the first — pass it back via `BhwWhatsNewOptions`.
   */
  readonly resultSetId: number;
  readonly xfToken: string;
}

export interface BhwWhatsNewOptions {
  /** 1-based page number (default 1). BHW caps the feed at 10 pages. */
  readonly page?: number;
  /**
   * Result-set id from a previous page's response. Required when `page > 1`;
   * the id rotates as new posts arrive, so reuse it within one crawl only.
   */
  readonly resultSetId?: number;
  readonly signal?: AbortSignal;
}

/** BHW returned an unexpected what's-new response. */
export class BhwWhatsNewError extends Error {
  override readonly name = "BhwWhatsNewError";
}

/* ---------------------------------------------------------------------------
 * Fetch & parse
 * ------------------------------------------------------------------------- */

/**
 * Fetch the "What's new → posts" feed.
 *
 * Page 1 goes to `/whats-new/posts/` which redirects to
 * `/whats-new/posts/{resultSetId}/`; later pages append `/page-N` to that
 * URL, so `resultSetId` must come from an earlier page in the same crawl.
 */
export async function fetchBhwWhatsNew(
  transport: BhwFetchTransport,
  origin: URL,
  options: BhwWhatsNewOptions = {},
): Promise<BhwWhatsNewPage> {
  const page = options.page ?? 1;

  let path: string;
  if (page <= 1) {
    path = "/whats-new/posts/";
  } else {
    if (options.resultSetId === undefined) {
      throw new BhwWhatsNewError(
        "resultSetId is required for page > 1 — take it from the page-1 response",
      );
    }
    path = `/whats-new/posts/${options.resultSetId}/page-${page}`;
  }

  const response = await transport.fetch(new URL(path, origin), {
    headers: { accept: "text/html" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const html = await response.text();

  if (html.includes("Just a moment") || html.includes("cf-challenge")) {
    throw new BhwWhatsNewError(
      "What's-new feed returned a Cloudflare challenge — manual account attention is required; do not retry automatically",
    );
  }

  const resultSetId = parseInt(
    response.url.match(/\/whats-new\/posts\/(\d+)/)?.[1] ?? "0",
    10,
  );
  return parseBhwWhatsNewPage(html, resultSetId);
}

/** Parse a what's-new feed page without making a request. */
export function parseBhwWhatsNewPage(
  html: string,
  resultSetId = 0,
): BhwWhatsNewPage {
  const $ = load(html);
  const xfToken = extractXfToken(html);

  const items: BhwFeedItem[] = [];
  $(".structItem.structItem--thread").each((_, el) => {
    const $el = $(el);

    const titleLink = $el.find(".structItem-title a").last();
    const href = titleLink.attr("href") ?? "";
    const slugMatch = href.match(/\/([\w-]+)\.(\d+)\//);
    const classId = ($el.attr("class") ?? "").match(
      /js-threadListItem-(\d+)/,
    );
    const threadId = parseInt(slugMatch?.[2] ?? classId?.[1] ?? "0", 10);
    if (threadId === 0) return;

    const starterLink = $el
      .find('.structItem-minor a[href*="/members/"]')
      .first();
    const forumLink = $el.find('.structItem-minor a[href*="/forums/"]').first();
    const latestLink = $el
      .find('.structItem-cell--latest a[href*="/members/"], .structItem-latestDate a[href*="/members/"]')
      .first();

    const startTime = $el.find(".structItem-startDate time").first();
    const latestTime = $el.find("time").last();

    const metaText = $el
      .find(".structItem-cell--meta, .structItem-parts")
      .text();
    const replies = metaText.match(/Replies?\s*([\d,]+)/i);
    const views = metaText.match(/Views?\s*([\d,]+)/i);

    items.push({
      threadId,
      title: titleLink.text().replace(/\s+/g, " ").trim(),
      slug: slugMatch?.[1] ?? "",
      url: href,
      forumName: forumLink.text().trim(),
      forumUrl: forumLink.attr("href") ?? "",
      author: ($el.attr("data-author") ?? starterLink.text()).trim(),
      authorId: memberId(starterLink.attr("href")),
      startedAt: parseXfDate(
        startTime.attr("data-time"),
        startTime.attr("datetime"),
      ),
      lastPoster: latestLink.text().trim(),
      lastPosterId: memberId(latestLink.attr("href")),
      lastPostAt: parseXfDate(
        latestTime.attr("data-time"),
        latestTime.attr("datetime"),
      ),
      replyCount: replies ? parseInt(replies[1]!.replace(/,/g, ""), 10) : 0,
      viewCount: views ? parseInt(views[1]!.replace(/,/g, ""), 10) : 0,
    });
  });

  return {
    items,
    pagination: parseXfPagination($),
    resultSetId,
    xfToken,
  };
}

/** `/members/name.123/` → 123. */
function memberId(href: string | undefined): number {
  return parseInt((href ?? "").match(/\.(\d+)\//)?.[1] ?? "0", 10) || 0;
}
