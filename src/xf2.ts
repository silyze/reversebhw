import { load } from "cheerio/slim";
import type { CheerioAPI } from "cheerio";

/**
 * XenForo 2 shared protocol helpers.
 *
 * Every XF2 AJAX request carries the same envelope of `_xfToken`,
 * `_xfResponseType`, `_xfWithData`, and `_xfRequestUri`. These helpers
 * extract and build that envelope so domain modules stay focused on
 * their own field sets.
 */

/** CSRF token format: `{timestamp},{hex-hash}`. */
const XF_TOKEN_PATTERN = /^\d+,[0-9a-f]+$/i;

export interface XfAjaxParams {
  readonly _xfToken: string;
  readonly _xfResponseType: "json";
  readonly _xfWithData: 1;
  readonly _xfRequestUri: string;
}

/**
 * Extract the `_xfToken` CSRF value from a page or XF2 JSON overlay.
 *
 * XF2 embeds the token in a hidden `<input name="_xfToken">` inside the
 * HTML body, and also returns it inside `json.html` overlays.
 */
export function extractXfToken(html: string): string {
  const $ = load(html);
  const token = $(
    'input[name="_xfToken"][type="hidden"], input[name="_xfToken"]',
  )
    .first()
    .attr("value");

  if (token === undefined || !XF_TOKEN_PATTERN.test(token)) {
    throw new XfProtocolError(
      "Could not find a valid _xfToken in the page. The response may be a Cloudflare challenge.",
    );
  }
  return token;
}

/** Build the standard XF2 AJAX envelope shared by every XHR request. */
export function xfAjaxParams(
  token: string,
  requestUri: string,
): XfAjaxParams {
  return {
    _xfToken: token,
    _xfResponseType: "json",
    _xfWithData: 1,
    _xfRequestUri: requestUri,
  };
}

/**
 * Attach XF2 AJAX query parameters to a URL.
 *
 * XF2 GET requests carry the envelope in the query string.
 */
export function withXfQuery(
  url: string | URL,
  token: string,
  requestUri: string,
): URL {
  const target = url instanceof URL ? url : new URL(url);
  target.searchParams.set("_xfResponseType", "json");
  target.searchParams.set("_xfWithData", "1");
  target.searchParams.set("_xfRequestUri", requestUri);
  target.searchParams.set("_xfToken", token);
  return target;
}

/** Standard headers every XF2 AJAX request sends. */
export const XF_AJAX_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "x-requested-with": "XMLHttpRequest",
} as const;

/** Headers for a multipart form-data POST. */
export const XF_FORM_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "x-requested-with": "XMLHttpRequest",
} as const;

/** BHW returned an unexpected response shape or a Cloudflare interstitial. */
export class XfProtocolError extends Error {
  override readonly name = "XfProtocolError";
}

/** Parse an XF2 JSON response body and assert it is an object. */
export function parseXfJson(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new XfProtocolError("XF2 response was not a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Check whether an XF2 JSON response reported an error. */
export function xfHasError(body: Record<string, unknown>): boolean {
  if (body.status === "error") return true;
  return Array.isArray(body.errors) && body.errors.length > 0;
}

/** Extract the error message from an XF2 error JSON response. */
export function xfErrorMessage(body: Record<string, unknown>): string {
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => String(e)).join("; ");
  }
  if (typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  const errorHtml = body.errorHtml;
  if (typeof errorHtml === "object" && errorHtml !== null && "content" in errorHtml) {
    const text = String(
      (errorHtml as Record<string, unknown>).content,
    ).replace(/<[^>]*>/g, "").trim();
    if (text.length > 0) return text;
  }
  return `unknown XF2 error: ${JSON.stringify(body).slice(0, 200)}`;
}

/* ---------------------------------------------------------------------------
 * Shared page parsing
 * ------------------------------------------------------------------------- */

/** Pagination state parsed from an XF2 pageNav block. */
export interface BhwPagination {
  readonly currentPage: number;
  readonly totalPages: number;
  /** URL of the next page, when not on the last page. */
  readonly nextPageUrl?: string;
  /** URL of the last page, when the listing has multiple pages. */
  readonly lastPageUrl?: string;
}

/**
 * Parse XF2's pageNav: current/total from the "X of Y" indicator, plus
 * next/last page links. Single-page listings have no nav at all.
 */
export function parseXfPagination($: CheerioAPI): BhwPagination {
  const currentText = $(".pageNavSimple-el--current").first().text().trim();
  const match = currentText.match(/(\d+)\s*of\s*(\d+)/i);
  const currentPage = match ? parseInt(match[1]!, 10) : 1;
  const totalPages = match ? parseInt(match[2]!, 10) : 1;

  const nextHref = $("a.pageNav-jump--next").first().attr("href");
  const lastHref = $(".pageNavSimple-el--last a, a.pageNavSimple-el--last")
    .first()
    .attr("href");

  return {
    currentPage,
    totalPages,
    ...(nextHref === undefined ? {} : { nextPageUrl: nextHref }),
    ...(lastHref === undefined ? {} : { lastPageUrl: lastHref }),
  };
}

/**
 * XF2 timestamps: usually unix `data-time`, but BHW's theme puts the clock
 * time there and ISO 8601 in `datetime` — with an uncolonated UTC offset
 * (`+0100`) that Date.parse rejects.
 */
export function parseXfDate(
  dataTime: string | undefined,
  datetime: string | undefined,
): number {
  const unix = Number(dataTime);
  if (Number.isFinite(unix) && unix > 100_000_000) return unix;
  const normalized = (datetime ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
