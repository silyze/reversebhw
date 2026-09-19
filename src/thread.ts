import { load } from "cheerio/slim";
import type { CheerioAPI } from "cheerio";

import {
  XF_FORM_HEADERS,
  extractXfToken,
  parseXfJson,
  parseXfDate,
  parseXfPagination,
  xfErrorMessage,
  xfHasError,
  type BhwPagination,
} from "./xf2.js";

import type { BhwFetchTransport } from "./session.js";

export type { BhwPagination } from "./xf2.js";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface BhwThread {
  readonly threadId: number;
  readonly title: string;
  readonly slug: string;
  readonly forumName: string;
  readonly postCount: number;
  readonly viewCount: number;
}

export interface BhwThreadPost {
  readonly postId: number;
  readonly threadId: number;
  readonly author: string;
  readonly authorId: number;
  readonly date: number;
  readonly messageHtml: string;
  readonly reactionScore: number;
  /** Relative permalink path, e.g. `/seo/slug.123/post-456`. */
  readonly permalink: string;
}

export interface BhwThreadPage {
  readonly thread: BhwThread;
  readonly posts: readonly BhwThreadPost[];
  readonly pagination: BhwPagination;
  readonly xfToken: string;
  /** Form attachment hash from the quick-reply form. */
  readonly attachmentHash: string;
  /** Exact quick-reply action emitted by BHW's live form. */
  readonly replyAction: string;
  /** Method declared by BHW's live quick-reply form. */
  readonly replyMethod: "POST" | "GET";
  /**
   * Hidden fields from BHW's live quick-reply form. These are carried into a
   * reply submission without logging their values. `_xfToken`, editor text,
   * and live-update fields are refreshed by the caller before submission.
   */
  readonly replyFormFields: Readonly<Record<string, string>>;
  /** True only when the live page exposes an enabled quick-reply form. */
  readonly canReply: boolean;
}

export interface BhwFetchThreadOptions {
  /**
   * Thread slug. Optional — XF2 canonicalizes any slug (even a bogus one)
   * to the thread's real URL.
   */
  readonly slug?: string;
  /** 1-based page number (default 1). */
  readonly page?: number;
  readonly signal?: AbortSignal;
}

export interface BhwReplyInput {
  readonly threadId: number;
  readonly slug: string;
  /** Rich-text editor HTML (XF2 `message_html` format). */
  readonly messageHtml: string;
  /** Exact quick-reply action obtained from a live `BhwThreadPage`. */
  readonly replyAction?: string;
  /** Method obtained from a live `BhwThreadPage`. */
  readonly replyMethod?: "POST" | "GET";
  /** Hidden fields obtained from a live `BhwThreadPage`. */
  readonly replyFormFields?: Readonly<Record<string, string>>;
  /** Post ID being replied to (for threaded quote replies). */
  readonly parentId?: number;
  readonly attachmentHash?: string;
  /** `last_date` / `last_known_date` from the page, used for live-update diffing. */
  readonly lastDate?: number;
  readonly signal?: AbortSignal;
}

export interface BhwReplyResult {
  readonly postId: number;
  readonly redirect: string;
  /** HTTP response status returned by BHW. */
  readonly httpStatus: number;
  /** BHW's JSON response status, when supplied. */
  readonly responseStatus?: string;
  /** Names of fields present in BHW's JSON response; values are never exposed. */
  readonly responseFields: readonly string[];
}

export interface BhwDraftInput {
  readonly threadId: number;
  readonly slug: string;
  readonly messageHtml: string;
  readonly attachmentHash?: string;
  readonly signal?: AbortSignal;
}

/** BHW rejected a thread mutation or returned an unexpected response. */
export class BhwThreadError extends Error {
  override readonly name = "BhwThreadError";
}

/* ---------------------------------------------------------------------------
 * View thread
 * ------------------------------------------------------------------------- */

/**
 * Fetch and parse a thread page.
 *
 * URL pattern: `/threads/{slug}.{threadId}/` (+ `/page-N` for N > 1).
 * XF2 canonicalizes the slug, so a placeholder works when unknown.
 */
export async function fetchBhwThread(
  transport: BhwFetchTransport,
  origin: URL,
  threadId: number,
  options: BhwFetchThreadOptions = {},
): Promise<BhwThreadPage> {
  const slug = options.slug ?? "-";
  const page = options.page ?? 1;
  const path =
    `/threads/${slug}.${threadId}/` + (page > 1 ? `page-${page}` : "");
  const response = await transport.fetch(new URL(path, origin), {
    headers: { accept: "text/html" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const html = await response.text();

  if (html.includes("Just a moment") || html.includes("cf-challenge")) {
    throw new BhwThreadError(
      "Thread page returned a Cloudflare challenge — manual account attention is required; do not retry automatically",
    );
  }
  if (!response.ok) {
    const detail = response.status === 404
      ? "Thread was not found"
      : response.status === 401 || response.status === 403
        ? `Thread request returned HTTP ${response.status} — manual account attention is required; do not retry automatically`
        : `Thread request failed with HTTP ${response.status}`;
    throw new BhwThreadError(detail);
  }

  // Recover the canonical slug from the final (possibly redirected) URL.
  const canonical = response.url.match(/\/([\w-]+)\.\d+(?:\/|$)/);
  return parseBhwThreadPage(html, threadId, canonical?.[1] ?? slug);
}

/** Parse a BHW thread page without making a request. */
export function parseBhwThreadPage(
  html: string,
  threadId: number,
  slug: string,
): BhwThreadPage {
  const $ = load(html);
  const xfToken = extractXfToken(html);

  const title = normalizeText($("h1.p-title-value").first().text()) ||
    normalizeText($("title").first().text());

  const forumName =
    $("ul.p-breadcrumbs li a").last().text().trim() ||
    $("span.crumb > a").last().text().trim() ||
    $("li.breadcrumbItem").last().text().trim();

  const posts: BhwThreadPost[] = [];
  $("article.message").each((_, el) => {
    const $el = $(el);
    const postId = parseIntAttr($el, "data-content") ??
      parseIntAttr($el, "data-message-id");
    if (postId === null) return;

    const author = ($el.attr("data-author") ?? "").trim() ||
      $el.find(".message-name").first().text().trim();
    const authorLink = $el.find(".message-name a").first();
    const authorId = parseInt(
      authorLink.attr("data-user-id") ??
        (authorLink.attr("href") ?? "").match(/\.(\d+)\//)?.[1] ?? "0",
      10,
    ) || 0;
    const timeEl = $el.find("time").first();
    const date = parseXfDate(
      timeEl.attr("data-time"),
      timeEl.attr("datetime"),
    );
    const messageHtml = $el.find(".message-body .bbWrapper").first().html() ?? "";
    const reactionScore = parseInt(
      $el.find(".js-reactionList, .js-reactionsList").attr("data-reaction-score") ??
        "",
      10,
    ) || $el.find(".reactionsBar .reactionSummary > li").length;
    const permalink =
      $el.find(".message-attribution-main a[href*='/post-']").first().attr("href") ??
      "";

    posts.push({
      postId,
      threadId,
      author,
      authorId,
      date,
      messageHtml,
      reactionScore,
      permalink,
    });
  });

  const pagination = parseXfPagination($);

  const quickReplyForm = $(
    'form[action*="add-reply"], form.js-quickReply, form[data-xf-init*="quick-reply"]',
  ).first();
  const replyFormFields = hiddenFormFields($, quickReplyForm);
  const attachmentHash =
    replyFormFields.attachment_hash ??
    replyFormFields.attachment_hash_combined ??
    $('input[name="attachment_hash"]').attr("value") ??
    $('input[name="attachment_hash_combined"]').attr("value") ??
    "";
  const replyMethod = (quickReplyForm.attr("method") ?? "POST").toUpperCase() === "GET"
    ? "GET"
    : "POST";
  const closedNotice = $(
    ".blockMessage--error, .blockMessage--important, .blockMessage--warning, .message--notice, .js-threadStatus",
  ).text();
  const canReply = quickReplyForm.length > 0
    && quickReplyForm.find(':input:disabled').length === 0
    && !/\b(thread\s+is\s+closed|closed\s+for\s+further\s+replies|locked)\b/i.test(closedNotice);

  const postCount = parseInt(
    $(".block-outer dl.pairs > dd").first().text().replace(/[^0-9]/g, ""),
    10,
  ) || posts.length;
  const viewCount = parseInt(
    $(".block-outer dl.pairs > dd").eq(1).text().replace(/[^0-9]/g, ""),
    10,
  ) || 0;

  return {
    thread: { threadId, title, slug, forumName, postCount, viewCount },
    posts,
    pagination,
    xfToken,
    attachmentHash,
    replyAction: quickReplyForm.attr("action") ?? "",
    replyMethod,
    replyFormFields,
    canReply,
  };
}

/* ---------------------------------------------------------------------------
 * Reply to thread
 * ------------------------------------------------------------------------- */

/**
 * Post a reply to a thread.
 *
 * Submits multipart form data to `/{slug}.{threadId}/add-reply` using the
 * XF2 quick-reply contract observed in the HAR.
 */
export async function replyToBhwThread(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwReplyInput,
): Promise<BhwReplyResult> {
  const threadPath = `/threads/${input.slug}.${input.threadId}/`;
  const target = replyTarget(input.replyAction, input.replyMethod, threadPath, origin);
  const requestUri = target.pathname.replace(/\/add-reply$/, "/") || threadPath;
  const referer = new URL(requestUri, origin).href;
  const attachmentHash = input.attachmentHash ?? "";
  const lastDate = input.lastDate ?? 0;

  const body = new FormData();
  for (const [name, value] of Object.entries(input.replyFormFields ?? {})) {
    body.set(name, value);
  }
  body.set("_xfToken", xfToken);
  body.set("message_html", input.messageHtml);
  body.set("attachment_hash", attachmentHash);
  if (!body.has("attachment_hash_combined")) {
    body.set(
      "attachment_hash_combined",
      JSON.stringify({
        type: "post",
        context: { thread_id: input.threadId },
        hash: attachmentHash,
      }),
    );
  }
  body.set("last_date", String(lastDate));
  body.set("last_known_date", String(lastDate));
  if (input.parentId !== undefined) {
    body.set("parent_id", String(input.parentId));
  }
  body.set("load_extra", "1");
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", requestUri);

  const response = await transport.fetch(target, {
    method: "POST",
    headers: {
      ...XF_FORM_HEADERS,
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (!response.ok || xfHasError(json)) {
    throw new BhwThreadError(`Reply rejected: ${xfErrorMessage(json)}`);
  }

  if (typeof json.redirect !== "string" || json.redirect.length === 0) {
    throw new BhwThreadError("Reply response did not include BHW's post redirect; no post will be treated as published.");
  }
  const redirect = json.redirect;

  const postId = extractPostIdFromResponse(json);
  const responseStatus = typeof json.status === "string" ? json.status : undefined;

  return {
    postId,
    redirect,
    httpStatus: response.status,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    responseFields: Object.keys(json).sort(),
  };
}

function replyTarget(
  replyAction: string | undefined,
  replyMethod: "POST" | "GET" | undefined,
  threadPath: string,
  origin: URL,
): URL {
  if (replyMethod !== undefined && replyMethod !== "POST") {
    throw new BhwThreadError("BHW's live quick-reply form does not use POST; reply submission is blocked.");
  }
  const target = new URL(replyAction || `${threadPath}add-reply`, origin);
  if (target.origin !== origin.origin || !/\/add-reply$/.test(target.pathname)) {
    throw new BhwThreadError("The live quick-reply form has an invalid action URL.");
  }
  return target;
}

function hiddenFormFields(
  $: CheerioAPI,
  $form: ReturnType<CheerioAPI>,
): Record<string, string> {
  if ($form.length === 0) return {};
  const fields: Record<string, string> = {};
  $form.find("input[type=hidden][name]").each((_, el) => {
    const $input = $(el);
    const name = $input.attr("name");
    if (name !== undefined) fields[name] = $input.attr("value") ?? "";
  });
  return fields;
}

/* ---------------------------------------------------------------------------
 * Save draft
 * ------------------------------------------------------------------------- */

/** Save a reply draft for a thread. */
export async function saveBhwDraft(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwDraftInput,
): Promise<void> {
  const threadPath = `/threads/${input.slug}.${input.threadId}/`;
  const referer = new URL(threadPath, origin).href;

  const body = new FormData();
  body.set("_xfToken", xfToken);
  body.set("message_html", input.messageHtml);
  body.set("attachment_hash", input.attachmentHash ?? "");
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", threadPath);

  const response = await transport.fetch(new URL(`${threadPath}draft`, origin), {
    method: "POST",
    headers: {
      ...XF_FORM_HEADERS,
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwThreadError(`Draft save rejected: ${xfErrorMessage(json)}`);
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function extractPostIdFromResponse(
  json: Record<string, unknown>,
): number {
  // XF2 returns the new post inside json.html or a redirect URL containing #post-{id}.
  const redirect =
    typeof json.redirect === "string" ? json.redirect : "";
  const match = redirect.match(/(?:#|\/)post-(\d+)/);
  if (match) return parseInt(match[1]!, 10);

  if (typeof json.post === "number") return json.post;
  return 0;
}

function parseIntAttr(
  $el: { attr(name: string): string | undefined },
  attr: string,
): number | null {
  const value = $el.attr(attr) ?? "";
  const match = value.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
