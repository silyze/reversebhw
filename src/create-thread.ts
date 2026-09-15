import { load } from "cheerio/slim";

import {
  XF_FORM_HEADERS,
  extractXfToken,
  parseXfJson,
  xfErrorMessage,
  xfHasError,
} from "./xf2.js";
import { BhwThreadError } from "./thread.js";
import type { BhwFetchTransport } from "./session.js";

/** Inputs required to create a new thread in a BHW forum. */
export interface BhwCreateThreadInput {
  /** Forum landing page, or its direct new-thread composer URL. Must be on BHW. */
  readonly forumUrl: string | URL;
  readonly title: string;
  /** Rich-text editor HTML (XF2 `message_html` format). */
  readonly messageHtml: string;
  /** Optional attachment hash obtained from the thread composer. */
  readonly attachmentHash?: string;
  readonly signal?: AbortSignal;
}

/** A successfully accepted new-thread submission. */
export interface BhwCreateThreadResult {
  /** New thread ID when BHW includes it in the response; otherwise `0`. */
  readonly threadId: number;
  /** BHW's canonical redirect for the new thread. */
  readonly redirect: string;
}

/** Parsed new-thread composer metadata for advanced callers. */
export interface BhwThreadCreationForm {
  /** Canonical URL of the composer page that supplied this form. */
  readonly composerUrl: string;
  /** Same-origin form action to submit. */
  readonly actionUrl: string;
  readonly xfToken: string;
  /** Hidden form fields, including BHW/XF defaults required by the composer. */
  readonly hiddenFields: Readonly<Record<string, string>>;
}

/**
 * Fetch a forum's new-thread composer and parse its live form action and
 * hidden fields. Passing a direct composer URL is also supported.
 */
export async function fetchBhwThreadCreationForm(
  transport: BhwFetchTransport,
  origin: URL,
  forumUrl: string | URL,
  signal?: AbortSignal,
): Promise<BhwThreadCreationForm> {
  const forumTarget = sameOriginUrl(forumUrl, origin, "forum URL");
  const forumResponse = await transport.fetch(forumTarget, {
    headers: { accept: "text/html" },
    ...(signal === undefined ? {} : { signal }),
  });
  const forumHtml = await forumResponse.text();
  assertNotCloudflareChallenge(forumHtml, "Forum page");
  const resolvedForumUrl = sameOriginUrl(forumResponse.url, origin, "forum response URL");

  const directForm = tryParseBhwThreadCreationForm(
    forumHtml,
    resolvedForumUrl,
    origin,
  );
  if (directForm !== undefined) return directForm;

  const composerTarget = findThreadComposerUrl(forumHtml, resolvedForumUrl, origin);
  if (composerTarget === undefined) {
    throw new BhwThreadError(
      "Could not find a new-thread composer link on the forum page",
    );
  }

  const composerResponse = await transport.fetch(composerTarget, {
    headers: { accept: "text/html" },
    ...(signal === undefined ? {} : { signal }),
  });
  const composerHtml = await composerResponse.text();
  assertNotCloudflareChallenge(composerHtml, "New-thread composer");
  const composerUrl = sameOriginUrl(
    composerResponse.url,
    origin,
    "new-thread composer response URL",
  );
  const form = tryParseBhwThreadCreationForm(composerHtml, composerUrl, origin);
  if (form === undefined) {
    throw new BhwThreadError(
      "Could not find a new-thread form in the composer response",
    );
  }
  return form;
}

/**
 * Create a new thread by discovering the forum's live composer, then
 * submitting that form with BHW/XF's AJAX envelope.
 */
export async function createBhwThread(
  transport: BhwFetchTransport,
  origin: URL,
  input: BhwCreateThreadInput,
): Promise<BhwCreateThreadResult> {
  if (input.title.trim().length === 0) {
    throw new BhwThreadError("Thread title cannot be empty");
  }
  if (input.messageHtml.trim().length === 0) {
    throw new BhwThreadError("Thread message cannot be empty");
  }

  const form = await fetchBhwThreadCreationForm(
    transport,
    origin,
    input.forumUrl,
    input.signal,
  );
  const composerUrl = sameOriginUrl(form.composerUrl, origin, "composer URL");
  const actionUrl = sameOriginUrl(form.actionUrl, origin, "new-thread form action");
  const body = new FormData();

  for (const [name, value] of Object.entries(form.hiddenFields)) {
    body.set(name, value);
  }
  body.set("_xfToken", form.xfToken);
  body.set("title", input.title);
  body.set("message_html", input.messageHtml);

  if (input.attachmentHash !== undefined) {
    if (form.hiddenFields.attachment_hash === undefined) {
      throw new BhwThreadError(
        "New-thread form does not expose an attachment hash field",
      );
    }
    body.set("attachment_hash", input.attachmentHash);
    const combined = form.hiddenFields.attachment_hash_combined;
    if (combined !== undefined) {
      body.set(
        "attachment_hash_combined",
        withAttachmentHash(combined, input.attachmentHash),
      );
    }
  }

  const requestUri = relativeRequestUri(composerUrl);
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", requestUri);

  const response = await transport.fetch(actionUrl, {
    method: "POST",
    headers: {
      ...XF_FORM_HEADERS,
      referer: composerUrl.href,
    },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwThreadError(
      `New thread rejected: ${xfErrorMessage(json)}`,
    );
  }

  const redirect = typeof json.redirect === "string"
    ? json.redirect
    : composerUrl.href;
  return { redirect, threadId: extractThreadId(json, redirect) };
}

/** Parse a new-thread form from HTML without making a request. */
export function parseBhwThreadCreationForm(
  html: string,
  composerUrl: string | URL,
  origin: URL,
): BhwThreadCreationForm {
  const resolvedComposerUrl = sameOriginUrl(composerUrl, origin, "composer URL");
  const form = tryParseBhwThreadCreationForm(html, resolvedComposerUrl, origin);
  if (form === undefined) {
    throw new BhwThreadError("Could not find a new-thread form in the supplied HTML");
  }
  return form;
}

function tryParseBhwThreadCreationForm(
  html: string,
  composerUrl: URL,
  origin: URL,
): BhwThreadCreationForm | undefined {
  const $ = load(html);
  const form = $("form")
    .filter((_, element) => {
      const $form = $(element);
      const action = $form.attr("action") ?? "";
      return (
        /(?:post-thread|create-thread)/i.test(action) ||
        $form.find('input[name="title"]').length > 0
      );
    })
    .first();
  if (form.length === 0) return undefined;

  const action = form.attr("action");
  if (action === undefined || action.trim().length === 0) return undefined;

  const hiddenFields: Record<string, string> = {};
  form.find('input[type="hidden"][name]').each((_, element) => {
    const $input = $(element);
    const name = $input.attr("name");
    if (name === undefined || name.length === 0) return;
    hiddenFields[name] = $input.attr("value") ?? "";
  });

  const xfToken = hiddenFields._xfToken ?? extractXfToken(html);
  if (xfToken.trim().length === 0) {
    throw new BhwThreadError("New-thread form is missing _xfToken");
  }

  const actionUrl = sameOriginUrl(action, composerUrl, "new-thread form action");
  if (actionUrl.origin !== origin.origin) {
    throw new BhwThreadError("New-thread form action is outside the BHW origin");
  }

  return {
    composerUrl: composerUrl.href,
    actionUrl: actionUrl.href,
    xfToken,
    hiddenFields,
  };
}

function findThreadComposerUrl(
  html: string,
  forumUrl: URL,
  origin: URL,
): URL | undefined {
  const $ = load(html);
  const candidates = $("a[href]")
    .toArray()
    .map((element) => {
      const $link = $(element);
      return {
        href: $link.attr("href") ?? "",
        text: $link.text().replace(/\s+/g, " ").trim(),
      };
    });

  for (const candidate of candidates) {
    if (!/(?:post-thread|create-thread)/i.test(candidate.href)) continue;
    return sameOriginUrl(candidate.href, forumUrl, "new-thread composer link");
  }

  for (const candidate of candidates) {
    if (!/(?:post|new)\s+thread/i.test(candidate.text)) continue;
    return sameOriginUrl(candidate.href, forumUrl, "new-thread composer link");
  }

  return undefined;
}

function withAttachmentHash(combined: string, attachmentHash: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(combined);
  } catch {
    throw new BhwThreadError("New-thread attachment_hash_combined is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BhwThreadError("New-thread attachment_hash_combined has an invalid shape");
  }

  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    hash: attachmentHash,
  });
}

function extractThreadId(json: Record<string, unknown>, redirect: string): number {
  if (typeof json.thread === "number" && Number.isInteger(json.thread)) {
    return json.thread;
  }

  const match = redirect.match(/\/[^/?#]*\.(\d+)(?:\/|[?#]|$)/);
  return match === null ? 0 : parseInt(match[1]!, 10);
}

function relativeRequestUri(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function sameOriginUrl(
  input: string | URL,
  base: URL,
  label: string,
): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new BhwThreadError(`Invalid ${label}`);
  }
  if (url.origin !== base.origin) {
    throw new BhwThreadError(`${label} must use the BHW origin`);
  }
  return url;
}

function assertNotCloudflareChallenge(html: string, label: string): void {
  if (html.includes("Just a moment") || html.includes("cf-challenge")) {
    throw new BhwThreadError(
      `${label} returned a Cloudflare challenge — solve the WAF before retrying`,
    );
  }
}
