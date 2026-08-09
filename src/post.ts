import {
  parseXfJson,
  xfErrorMessage,
  xfHasError,
} from "./xf2.js";
import type { BhwFetchTransport } from "./session.js";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/** Reaction IDs observed in BHW's XF2 reaction palette. */
export type BhwReactionId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BhwReactInput {
  readonly postId: number;
  readonly reactionId: BhwReactionId;
  /** Thread path for the Referer header (e.g. `/seo/escort-seo.1829362/`). */
  readonly refererPath?: string;
  readonly signal?: AbortSignal;
}

export interface BhwReactResult {
  readonly reactionId: BhwReactionId;
  readonly isReacted: boolean;
}

export interface BhwQuoteInput {
  readonly postId: number;
  readonly refererPath?: string;
  readonly signal?: AbortSignal;
}

export interface BhwQuoteResult {
  /** HTML for the quote block to embed in a reply's `message_html`. */
  readonly quoteHtml: string;
}

export interface BhwEditPostInput {
  readonly postId: number;
  /** Updated rich-text editor HTML. */
  readonly messageHtml: string;
  readonly attachmentHash?: string;
  readonly inline?: boolean;
  readonly refererPath?: string;
  readonly signal?: AbortSignal;
}

export interface BhwEditPostResult {
  readonly postId: number;
  readonly redirect: string;
}

export interface BhwDeletePostInput {
  readonly postId: number;
  readonly reason: string;
  /** Soft-delete (default) or permanently remove. */
  readonly hardDelete?: boolean;
  readonly redirectUrl?: string;
  readonly refererPath?: string;
  readonly signal?: AbortSignal;
}

export interface BhwReportPostInput {
  readonly postId: number;
  readonly message: string;
  readonly refererPath?: string;
  readonly signal?: AbortSignal;
}

/** BHW rejected a post mutation or returned an unexpected response. */
export class BhwPostError extends Error {
  override readonly name = "BhwPostError";
}

/* ---------------------------------------------------------------------------
 * React
 * ------------------------------------------------------------------------- */

/**
 * Toggle a reaction on a post.
 *
 * Sends a JSON body to `/posts/{id}/react?reaction_id={n}` — the lightest
 * XF2 mutation in the observed contract.
 */
export async function reactToBhwPost(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwReactInput,
): Promise<BhwReactResult> {
  const path = `/posts/${input.postId}/react?reaction_id=${input.reactionId}`;
  const referer = input.refererPath !== undefined
    ? new URL(input.refererPath, origin).href
    : new URL("/", origin).href;

  const body = JSON.stringify({
    _xfResponseType: "json",
    _xfWithData: 1,
    _xfRequestUri: input.refererPath ?? "/",
    _xfToken: xfToken,
  });

  const response = await transport.fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwPostError(`Reaction rejected: ${xfErrorMessage(json)}`);
  }

  const isReacted = typeof json.action === "string"
    ? json.action === "react"
    : true;

  return { reactionId: input.reactionId, isReacted };
}

/* ---------------------------------------------------------------------------
 * Quote
 * ------------------------------------------------------------------------- */

/** Fetch the quote HTML for a post (used when building a reply that quotes it). */
export async function quoteBhwPost(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwQuoteInput,
): Promise<BhwQuoteResult> {
  const path = `/posts/${input.postId}/quote`;
  const referer = input.refererPath !== undefined
    ? new URL(input.refererPath, origin).href
    : new URL("/", origin).href;

  const body = JSON.stringify({
    quoteHtml: "",
    _xfResponseType: "json",
    _xfWithData: 1,
    _xfRequestUri: input.refererPath ?? "/",
    _xfToken: xfToken,
  });

  const response = await transport.fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwPostError(`Quote rejected: ${xfErrorMessage(json)}`);
  }

  const quoteHtml = extractHtmlContent(json);
  return { quoteHtml };
}

/* ---------------------------------------------------------------------------
 * Edit
 * ------------------------------------------------------------------------- */

/** Edit an existing post's content. */
export async function editBhwPost(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwEditPostInput,
): Promise<BhwEditPostResult> {
  const path = `/posts/${input.postId}/edit`;
  const referer = input.refererPath !== undefined
    ? new URL(input.refererPath, origin).href
    : new URL("/", origin).href;
  const attachmentHash = input.attachmentHash ?? "";

  const body = new FormData();
  body.set("_xfToken", xfToken);
  if (input.inline !== false) body.set("_xfInlineEdit", "1");
  body.set("message_html", input.messageHtml);
  body.set("attachment_hash", attachmentHash);
  body.set(
    "attachment_hash_combined",
    JSON.stringify({
      type: "post",
      context: { post_id: input.postId },
      hash: attachmentHash,
    }),
  );
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", input.refererPath ?? "/");

  const response = await transport.fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwPostError(`Edit rejected: ${xfErrorMessage(json)}`);
  }

  const redirect =
    typeof json.redirect === "string"
      ? json.redirect
      : new URL("/", origin).href;

  return { postId: input.postId, redirect };
}

/* ---------------------------------------------------------------------------
 * Delete
 * ------------------------------------------------------------------------- */

/** Delete (soft or hard) an existing post. */
export async function deleteBhwPost(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwDeletePostInput,
): Promise<void> {
  const path = `/posts/${input.postId}/delete`;
  const referer = input.refererPath !== undefined
    ? new URL(input.refererPath, origin).href
    : new URL("/", origin).href;
  const redirect = input.redirectUrl ??
    (input.refererPath !== undefined
      ? new URL(input.refererPath, origin).href
      : new URL("/", origin).href);

  const body = new FormData();
  body.set("_xfToken", xfToken);
  body.set("reason", input.reason);
  body.set("hard_delete", input.hardDelete === true ? "1" : "0");
  body.set("_xfRedirect", redirect);
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", input.refererPath ?? "/");

  const response = await transport.fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwPostError(`Delete rejected: ${xfErrorMessage(json)}`);
  }
}

/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------- */

/** Report a post to moderators. */
export async function reportBhwPost(
  transport: BhwFetchTransport,
  origin: URL,
  xfToken: string,
  input: BhwReportPostInput,
): Promise<void> {
  const path = `/posts/${input.postId}/report`;
  const referer = input.refererPath !== undefined
    ? new URL(input.refererPath, origin).href
    : new URL("/", origin).href;

  const body = new FormData();
  body.set("_xfToken", xfToken);
  body.set("message", input.message);
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", input.refererPath ?? "/");

  const response = await transport.fetch(new URL(path, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwPostError(`Report rejected: ${xfErrorMessage(json)}`);
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function extractHtmlContent(json: Record<string, unknown>): string {
  const html = json.html;
  if (typeof html === "object" && html !== null && "content" in html) {
    const content = (html as Record<string, unknown>).content;
    return typeof content === "string" ? content : "";
  }
  return typeof html === "string" ? html : "";
}
