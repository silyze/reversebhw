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

/** Search-order values emitted by BHW result-set URLs. */
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
  /** Final BHW search-result URL after its temporary result-set redirect. */
  readonly resultUrl?: string;
}

export interface BhwSearchOptions {
  /** 1-based results page; defaults to 1. */
  readonly page?: number;
  /** BHW's supported result ordering; defaults to newest first. */
  readonly order?: BhwSearchOrder;
  readonly signal?: AbortSignal;
}

/** BHW returned an unexpected search response. */
export class BhwSearchError extends Error {
  override readonly name = "BhwSearchError";
}

type BhwSearchForm = {
  action: URL;
  method: "GET" | "POST";
  controls: URLSearchParams;
  queryField: string;
  orderField?: string;
};

/* ---------------------------------------------------------------------------
 * Fetch & parse
 * ------------------------------------------------------------------------- */

/**
 * Search BHW through its own standard search form.
 *
 * BHW creates a temporary search-result set and redirects to
 * `/search/{resultSetId}/?q=...&o=date`. Its form fields can vary by theme,
 * so the form is read first and submitted with its declared method. The flow
 * is read-only and intentionally does not try to solve Cloudflare challenges.
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

  const formResponse = await transport.fetch(new URL("/search/search", origin), {
    headers: { accept: "text/html" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const formHtml = await formResponse.text();

  assertSearchResponse(formResponse.status, formResponse.ok, formHtml, "Search form request");
  const form = parseBhwSearchForm(formHtml, formResponse.url, origin);
  form.controls.set(form.queryField, query);
  if (form.orderField !== undefined) form.controls.set(form.orderField, options.order ?? "date");

  let response = await submitBhwSearchForm(transport, form, options.signal);
  let html = await response.text();
  assertSearchResponse(response.status, response.ok, html, "Search request");
  assertSearchResultSetUrl(response.url, origin);

  if (page > 1) {
    const resultsUrl = new URL(response.url, origin);
    const resultSetMatch = resultsUrl.pathname.match(/^\/search\/(\d+)\/$/);
    if (resultSetMatch === null) {
      throw new BhwSearchError("Search form did not redirect to a BHW results page");
    }
    resultsUrl.pathname = `/search/${resultSetMatch[1]}/page-${page}`;
    response = await transport.fetch(resultsUrl, {
      headers: { accept: "text/html" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    html = await response.text();
    assertSearchResponse(response.status, response.ok, html, "Search results request");
  }

  return { ...parseBhwSearchPage(html), resultUrl: response.url };
}

function parseBhwSearchForm(html: string, responseUrl: string, origin: URL): BhwSearchForm {
  const $ = load(html);
  const $form = $("form[action]").filter((_, el) => {
    const action = $(el).attr("action") ?? "";
    return new URL(action, responseUrl).pathname === "/search/search";
  }).first();
  if ($form.length === 0) throw new BhwSearchError("Could not find BHW's search form");

  const action = new URL($form.attr("action") ?? "/search/search", responseUrl);
  if (action.origin !== origin.origin) throw new BhwSearchError("BHW search form points to another origin");
  const method = ($form.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const controls = new URLSearchParams();

  $form.find("input[name]").each((_, el) => {
    const $input = $(el);
    const type = ($input.attr("type") ?? "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && $input.attr("checked") === undefined) return;
    if (["submit", "button", "reset", "file"].includes(type)) return;
    controls.set($input.attr("name")!, $input.attr("value") ?? "");
  });
  $form.find("textarea[name]").each((_, el) => {
    const $textarea = $(el);
    controls.set($textarea.attr("name")!, $textarea.text());
  });
  $form.find("select[name]").each((_, el) => {
    const $select = $(el);
    const $option = $select.find("option[selected]").first().length > 0
      ? $select.find("option[selected]").first()
      : $select.find("option").first();
    controls.set($select.attr("name")!, $option.attr("value") ?? "");
  });

  const $query = $form.find('input[name="q"], input[name="keywords"], textarea[name="q"], textarea[name="keywords"]').first();
  const queryField = $query.attr("name");
  if (queryField === undefined) throw new BhwSearchError("BHW search form has no query field");

  return {
    action,
    method,
    controls,
    queryField,
    ...(controls.has("o")
      ? { orderField: "o" }
      : controls.has("order")
        ? { orderField: "order" }
        : controls.has("c[order]")
          ? { orderField: "c[order]" }
          : {}),
  };
}

async function submitBhwSearchForm(
  transport: BhwFetchTransport,
  form: BhwSearchForm,
  signal: AbortSignal | undefined,
) {
  if (form.method === "GET") {
    const url = new URL(form.action);
    for (const [name, value] of form.controls) url.searchParams.set(name, value);
    return transport.fetch(url, {
      headers: { accept: "text/html" },
      ...(signal === undefined ? {} : { signal }),
    });
  }
  return transport.fetch(form.action, {
    method: "POST",
    headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
    body: form.controls,
    ...(signal === undefined ? {} : { signal }),
  });
}

function assertSearchResponse(status: number, ok: boolean, html: string, prefix: string): void {
  if (hasCloudflareChallenge(status, html)) {
    throw new BhwSearchError(
      "Search returned a Cloudflare challenge — manual account attention is required; do not retry automatically",
    );
  }
  if (!ok) throw new BhwSearchError(`${prefix} failed with HTTP ${status}`);
}

function assertSearchResultSetUrl(responseUrl: string, origin: URL): void {
  const url = new URL(responseUrl, origin);
  if (!/^\/search\/\d+\/$/.test(url.pathname)) {
    throw new BhwSearchError("Search form did not redirect to a BHW results page");
  }
}

/** Parse BHW thread search HTML without making a request. */
export function parseBhwSearchPage(html: string): BhwSearchPage {
  const $ = load(html);
  const xfToken = extractXfToken(html);
  const items: BhwSearchItem[] = [];

  $(
    ".structItem.structItem--thread, .structItem[class*='js-threadListItem-'], .structItem[data-content^='thread-'], .searchResult, .search-result, [data-thread-id], .block-row",
  ).each((_, el) => {
    const $el = $(el);
    const titleLink = findThreadTitleLink($, $el);
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
      .find(
        '.structItem-minor a[href*="/members/"], .structItem-cell--icon a[href*="/members/"], .contentRow-minor a[href*="/members/"]',
      )
      .first();
    const forumLink = findForumLink($, $el);
    const latestLink = $el
      .find(
        '.structItem-cell--latest a[href*="/members/"], .structItem-latestDate a[href*="/members/"]',
      )
      .first();
    const startTime = $el
      .find(".structItem-startDate time, .contentRow-minor time")
      .first();
    const latestTime = $el
      .find(".structItem-cell--latest time, .structItem-latestDate time")
      .last();
    const fallbackLatestTime =
      latestTime.length > 0 ? latestTime : $el.find("time").last();
    const metaText = $el
      .find(".structItem-cell--meta, .structItem-parts, .contentRow-minor")
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
        startTime.attr("data-timestamp") ?? startTime.attr("data-time"),
        startTime.attr("datetime"),
      ),
      lastPoster: normalizeText(latestLink.text()),
      lastPosterId: memberId(latestLink.attr("href")),
      lastPostAt: parseXfDate(
        fallbackLatestTime.attr("data-timestamp") ?? fallbackLatestTime.attr("data-time"),
        fallbackLatestTime.attr("datetime"),
      ),
      replyCount: countFromMeta(metaText, "replies"),
      viewCount: countFromMeta(metaText, "views"),
      excerpt: normalizeText(
        $el
          .find(
            ".structItem-snippet, .structItem-description, .searchResult-snippet, .contentRow-snippet",
          )
          .first()
          .text(),
      ),
    });
  });

  if (items.length === 0) {
    const seenThreadIds = new Set<number>();
    $("a[href]").each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href") ?? "";
      const threadRef = parseThreadReference(href);
      if (threadRef === undefined || !isThreadHref(href) || seenThreadIds.has(threadRef.threadId)) return;
      const title = normalizeText($link.text());
      if (title.length === 0) return;
      seenThreadIds.add(threadRef.threadId);
      items.push({
        threadId: threadRef.threadId,
        title,
        slug: threadRef.slug,
        url: href,
        forumName: "",
        forumUrl: "",
        author: "",
        authorId: 0,
        startedAt: 0,
        lastPoster: "",
        lastPosterId: 0,
        lastPostAt: 0,
        replyCount: 0,
        viewCount: 0,
        excerpt: "",
      });
    });
  }

  return {
    items,
    pagination: parseXfPagination($),
    xfToken,
  };
}

function findThreadTitleLink(
  $: ReturnType<typeof load>,
  $el: ReturnType<ReturnType<typeof load>>,
) {
  const conventional = $el.find(
    ".structItem-title a, .searchResult-title a, .contentRow-title a, .title a, h1 a, h2 a, h3 a",
  ).first();
  if (conventional.length > 0) return conventional;

  const preferred = $el.find("a[href]").filter((_, el) => {
    const href = $(el).attr("href") ?? "";
    return isThreadHref(href);
  }).first();
  if (preferred.length > 0) return preferred;

  return $el.find("a").first();
}

function isThreadHref(href: string): boolean {
  if (!parseThreadReference(href)) return false;
  const path = new URL(href, "https://www.blackhatworld.com").pathname;
  return !/^\/(?:members|forums|posts|search|tags|account|whats-new)(?:\/|$)/i.test(path);
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
  const explicit = $el
    .find('.structItem-minor a[href*="/forums/"], .contentRow-minor a[href*="/forums/"]')
    .first();
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
