import { load } from "cheerio/slim";

import type {
  CaptchaSolveOptions,
  CaptchaSolver,
  TurnstileChallenge,
} from "./captcha.js";
import {
  XF_AJAX_HEADERS,
  extractXfToken,
  parseXfJson,
  withXfQuery,
  xfErrorMessage,
  xfHasError,
} from "./xf2.js";
import { BHW_TURNSTILE_SITEKEY } from "./register.js";
import type { BhwFetchTransport } from "./session.js";

export interface BhwLoginInput {
  readonly username: string;
  readonly password: string;
  /** Stay logged in across sessions. Defaults to `true`. */
  readonly remember?: boolean;
}

export interface BhwLoginOptions {
  readonly captchaSolver?: CaptchaSolver<TurnstileChallenge>;
  readonly captchaSolveOptions?: CaptchaSolveOptions;
  readonly signal?: AbortSignal;
}

export interface BhwLoginResult {
  /** Redirect URL after successful login. */
  readonly redirect: string;
  readonly username: string;
}

/** BHW rejected a login attempt or returned an unexpected response. */
export class BhwLoginError extends Error {
  override readonly name = "BhwLoginError";
}

/**
 * Authenticate a BHW account via XenForo 2's standard login flow.
 *
 * Flow:
 * 1. Fetch the login overlay (XF2 JSON with embedded HTML).
 * 2. Extract the CSRF token and detect Turnstile.
 * 3. If Turnstile is present, solve it.
 * 4. Submit credentials as form data.
 */
export async function loginBhwAccount(
  transport: BhwFetchTransport,
  origin: URL,
  input: BhwLoginInput,
  options: BhwLoginOptions = {},
): Promise<BhwLoginResult> {
  const loginHtml = await fetchLoginOverlay(transport, origin);
  const xfToken = extractXfToken(loginHtml);
  const widget = detectTurnstileWidget(loginHtml);

  let turnstileToken: string | undefined;
  if (widget !== undefined && options.captchaSolver !== undefined) {
    const challenge: TurnstileChallenge = {
      type: "turnstile",
      url: new URL("/login/login", origin).href,
      sitekey: widget.sitekey,
      ...(widget.action === undefined ? {} : { action: widget.action }),
    };
    const solution = await options.captchaSolver.solve(
      challenge,
      options.captchaSolveOptions,
    );
    if (solution.type === "turnstile") {
      turnstileToken = solution.token;
    }
  }

  const body = new FormData();
  body.set("login", input.username);
  body.set("password", input.password);
  body.set("remember", input.remember === false ? "0" : "1");
  body.set("_xfToken", xfToken);
  body.set("_xfResponseType", "json");
  body.set("_xfWithData", "1");
  body.set("_xfRequestUri", "/");
  if (turnstileToken !== undefined) {
    body.set("cf-turnstile-response", turnstileToken);
  }

  const response = await transport.fetch(
    new URL("/login/login", origin),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

  const json = parseXfJson(await response.json());

  if (xfHasError(json)) {
    throw new BhwLoginError(
      `Login rejected: ${xfErrorMessage(json)}`,
    );
  }

  // XF2 login returns 200 with a redirect on success, or an error overlay.
  const redirect =
    typeof json.redirect === "string"
      ? json.redirect
      : new URL("/", origin).href;

  // Detect "requires two-factor" or other intermediate states.
  if (typeof json.html === "object" && json.html !== null) {
    const htmlContent = (json.html as Record<string, unknown>).content;
    if (typeof htmlContent === "string" && htmlContent.includes("twofactor")) {
      throw new BhwLoginError(
        "Account requires two-factor authentication, which is not yet supported",
      );
    }
  }

  return { redirect, username: input.username };
}

async function fetchLoginOverlay(
  transport: BhwFetchTransport,
  origin: URL,
): Promise<string> {
  // Seed cookies and capture the page token — the overlay is only served
  // with a valid token (an empty one silently returns no HTML).
  const seedResponse = await transport.fetch(new URL("/", origin), {
    headers: { accept: "text/html" },
  });
  const pageToken = extractXfToken(await seedResponse.text());

  const url = withXfQuery(new URL("/login/", origin), pageToken, "/");
  const response = await transport.fetch(url, { headers: XF_AJAX_HEADERS });
  const json = parseXfJson(await response.json());
  const htmlContent =
    typeof json.html === "object" && json.html !== null &&
        "content" in json.html
      ? String((json.html as Record<string, unknown>).content)
      : typeof json.html === "string"
        ? json.html
        : "";
  if (htmlContent.length === 0) {
    throw new BhwLoginError(
      "Login overlay returned no HTML content — the response may be a Cloudflare challenge",
    );
  }
  return htmlContent;
}

interface TurnstileWidgetHints {
  readonly sitekey: string;
  readonly action?: string;
}

function detectTurnstileWidget(html: string): TurnstileWidgetHints | undefined {
  const $ = load(html);
  const el =
    $(".cf-turnstile[data-sitekey]").length > 0
      ? $(".cf-turnstile[data-sitekey]").first()
      : $("[data-sitekey]").first();
  const sitekey = el.attr("data-sitekey");
  if (sitekey === undefined) return undefined;
  const action = el.attr("data-action") || undefined;
  return {
    sitekey,
    ...(action === undefined ? {} : { action }),
  };
}

/** BHW's default Turnstile sitekey if not detected on the page. */
export const BHW_LOGIN_FALLBACK_SITEKEY = BHW_TURNSTILE_SITEKEY;
