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

/** Sort order supported by XenForo's standard search form. */
export type BhwSearchOrder = "relevance" | "date";

/** One thread row returned by BHW's standard XenForo search results. */
export interface BhwSearchItem {
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
  /** Author of the latest post, when BHW includes it in the row. */
  readonly lastPoster: string;
  readonly lastPosterId: number;
  /** Unix timestamp of the latest post. */
  readonly lastPostAt: number;
  readonly replyCount: number;
  readonly viewCount: number;
  /** Search-result preview text, if the current BHW theme renders one. */
  readonly excerpt: string;
}

export interface BhwSearchPage {
  readonly items: readonly BhwSearchItem[];
  readonly pagination: BhwPagination;
  /** The page's XF token, useful to callers sharing a client session. */
  readonly xfToken: string;
}

export interface BhwSearchOptions {
  /** 1-based results page; defaults to 1. */
  readonly page?: number;
  /** Limit matches to thread titles instead of title and first-post content. */
  readonly titleOnly?: boolean;
  /** Result ordering; defaults to newest first for opportunity discovery. */
  readonly order?: BhwSearchOrder;
  readonly signal?: AbortSignal;
}

/** BHW returned an unexpected search response. */
export class BhwSearchError extends Error {
  override readonly name = "BhwSearchError";
}

/* ---------------------------------------------------------------------------
 * Fetch & parse
 * ------------------------------------------------------------------------- */

/**
 * Search BHW threads through XenForo's public standard GET endpoint.
 *
 * This does not require a CSRF token or a logged-in session. When cookies are
 * present on the supplied transport, XenForo simply applies that session's
 * normal visibility permissions. The request is read-only and intentionally
 * does not try to solve Cloudflare challenges.
 */
export async function fetchBhwSearch(
  transport: BhwFetchTransport,
  origin: URL,
  keywords: string,
  options: BhwSearchOptions = {},
): Promise<BhwSearchPage> {
  const query = keywords.trim();
  if (query.length === 0) {
    throw new TypeError("Search keywords must not be empty");
  }
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new TypeError("Search page must be a positive integer");
  }

  // `search_type=post` + `c[content]=thread` is XenForo's documented
  // combination for thread results (rather than one result per matching post).
  const url = new URL("/search/search", origin);
  url.searchParams.set("keywords", query);
  url.searchParams.set("search_type", "post");
  url.searchParams.set("c[content]", "thread");
  url.searchParams.set("order", options.order ?? "date");
  if (page > 1) url.searchParams.set("page", String(page));
  if (options.titleOnly === true) {
    url.searchParams.set("c[title_only]", "1");
  }

  const response = await transport.fetch(url, {
    headers: { accept: "text/html" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const html = await response.text();

  if (hasCloudflareChallenge(response.status, html)) {
    throw new BhwSearchError(
      "Search returned a Cloudflare challenge — manual account attention is required; do not retry automatically",
    );
  }
  if (!response.ok) {
    throw new BhwSearchError(
      `Search request failed with HTTP ${response.status}`,
    );
  }

  return parseBhwSearchPage(html);
}

/** Parse BHW thread search HTML without making a request. */
export function parseBhwSearchPage(html: string): BhwSearchPage {
  const $ = load(html);
  const xfToken = extractXfToken(html);
  const items: BhwSearchItem[] = [];

  $(
    ".structItem.structItem--thread, .structItem[class*='js-threadListItem-'], .structItem[data-content^='thread-']",
  ).each((_, el) => {
    const $el = $(el);
    const titleLink = $el.find(".structItem-title a").last();
    const href = titleLink.attr("href") ?? "";
    const threadRef = parseThreadReference(href);
    const classId = ($el.attr("class") ?? "").match(
      /js-threadListItem-(\d+)/,
    );
    const contentId = ($el.attr("data-content") ?? "").match(
      /thread-(\d+)/,
    );
    const threadId =
      threadRef?.threadId ??
      parseInt(classId?.[1] ?? contentId?.[1] ?? "0", 10);
    if (!Number.isFinite(threadId) || threadId <= 0) return;

    const authorLink = $el
      .find('.structItem-minor a[href*="/members/"], .structItem-cell--icon a[href*="/members/"]')
      .first();
    const forumLink = findForumLink($, $el);
    const latestLink = $el
      .find(
        '.structItem-cell--latest a[href*="/members/"], .structItem-latestDate a[href*="/members/"]',
      )
      .first();
    const startTime = $el.find(".structItem-startDate time").first();
    const latestTime = $el
      .find(".structItem-cell--latest time, .structItem-latestDate time")
      .last();
    const fallbackLatestTime =
      latestTime.length > 0 ? latestTime : $el.find("time").last();
    const metaText = $el
      .find(".structItem-cell--meta, .structItem-parts")
      .text();

    items.push({
      threadId,
      title: normalizeText(titleLink.text()),
      slug: threadRef?.slug ?? "",
      url: href,
      forumName: normalizeText(forumLink.text()),
      forumUrl: forumLink.attr("href") ?? "",
      author: normalizeText($el.attr("data-author") ?? authorLink.text()),
      authorId: memberId(authorLink.attr("href")),
      startedAt: parseXfDate(
        startTime.attr("data-time"),
        startTime.attr("datetime"),
      ),
      lastPoster: normalizeText(latestLink.text()),
      lastPosterId: memberId(latestLink.attr("href")),
      lastPostAt: parseXfDate(
        fallbackLatestTime.attr("data-time"),
        fallbackLatestTime.attr("datetime"),
      ),
      replyCount: countFromMeta(metaText, "replies"),
      viewCount: countFromMeta(metaText, "views"),
      excerpt: normalizeText(
        $el
          .find(
            ".structItem-snippet, .structItem-description, .searchResult-snippet",
          )
          .first()
          .text(),
      ),
    });
  });

  return {
    items,
    pagination: parseXfPagination($),
    xfToken,
  };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function hasCloudflareChallenge(status: number, html: string): boolean {
  return (
    status === 403 && /cf-challenge|just a moment|enable javascript and cookies/i.test(html)
  );
}

function parseThreadReference(
  href: string,
): { readonly slug: string; readonly threadId: number } | undefined {
  const match = href.match(/\/([^/?#]+)\.(\d+)(?:\/|[?#]|$)/);
  if (match === null) return undefined;
  const threadId = parseInt(match[2]!, 10);
  if (!Number.isFinite(threadId) || threadId <= 0) return undefined;
  return { slug: match[1]!, threadId };
}

function findForumLink(
  $: ReturnType<typeof load>,
  $el: ReturnType<ReturnType<typeof load>>,
) {
  const explicit = $el.find('.structItem-minor a[href*="/forums/"]').first();
  if (explicit.length > 0) return explicit;

  // BHW's custom routes can use a non-`/forums/` forum path. The remaining
  // non-member link in the row is the best theme-independent fallback.
  return $el
    .find(".structItem-minor a")
    .filter((_, el) => {
      const href = $(el).attr("href") ?? "";
      return href.length > 0 && !href.includes("/members/");
    })
    .last();
}

/** `/members/name.123/` → 123. */
function memberId(href: string | undefined): number {
  return parseInt((href ?? "").match(/\.(\d+)(?:\/|$)/)?.[1] ?? "0", 10) || 0;
}

function countFromMeta(metaText: string, label: string): number {
  const match = metaText.match(new RegExp(`${label}\\s*:?\\s*([\\d,]+)`, "i"));
  return match === null ? 0 : parseInt(match[1]!.replace(/,/g, ""), 10) || 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
