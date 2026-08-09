import { getEmulationHeaders } from "wreq-js";

import type {
  CaptchaSolver,
  CloudflareWafChallenge,
} from "./captcha.js";
import type {
  BhwFetchInit,
  BhwFetchResponse,
  BhwFetchTransport,
  BhwSession,
} from "./session.js";

/** Cloudflare WAF clearance failed — the session is still interstitial-blocked. */
export class BhwWafError extends Error {
  override readonly name = "BhwWafError";
}

export interface BhwWafOptions {
  /** Maximum solve-and-retry cycles before giving up (default 3). */
  readonly maxAttempts?: number;
  /** Challenge page HTML we observed — lets the solver work from our copy. */
  readonly challengeHtml?: string;
  readonly signal?: AbortSignal;
}

/**
 * Detect Cloudflare's interstitial challenge page ("Just a moment…").
 *
 * BHW serves it with status 403 whenever `cf_clearance` is missing, expired,
 * or bound to a different client identity.
 */
export function isCloudflareChallenge(status: number, body: string): boolean {
  return (
    status === 403 &&
    (body.includes("Just a moment") ||
      body.includes("Enable JavaScript and cookies"))
  );
}

/**
 * Solve the Cloudflare WAF once and apply the clearance cookies to the session.
 *
 * The challenge carries the session's proxy and emulated User-Agent so the
 * clearance is minted for the same client identity that will use it.
 */
export async function clearCloudflareWaf(
  session: BhwSession,
  solver: CaptchaSolver,
  options: BhwWafOptions = {},
): Promise<void> {
  if (session.setCookie === undefined) {
    throw new BhwWafError(
      "This session cannot store cookies — WAF clearance requires a session created by createBhwSession",
    );
  }
  options.signal?.throwIfAborted();

  const config = session.config;
  const proxy = config?.proxy;
  const userAgent =
    config === undefined
      ? undefined
      : (getEmulationHeaders(config.browser, config.os).get("user-agent") ??
        undefined);

  const challenge: CloudflareWafChallenge = {
    type: "cloudflare-waf",
    url: session.origin.href,
    ...(proxy === undefined ? {} : { proxy }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(options.challengeHtml === undefined
      ? {}
      : { html: options.challengeHtml }),
  };
  const solution = await solver.solve(challenge, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (solution.type !== "cloudflare-waf") {
    throw new BhwWafError(`Expected WAF solution, got ${solution.type}`);
  }

  session.setCookie("cf_clearance", solution.clearance);
  if (solution.cfBm) session.setCookie("__cf_bm", solution.cfBm);
}

/**
 * Wrap a session's fetch so Cloudflare WAF interstitials are solved
 * transparently: on a challenge response the wrapper clears the WAF with the
 * given solver and re-issues the request, up to `maxAttempts` times.
 *
 * Non-challenge responses pass through untouched — only 403 bodies are read
 * (and replayed from a buffer) so streaming behavior is preserved.
 */
export function wafResilientTransport(
  session: BhwSession,
  solver: CaptchaSolver,
  options: BhwWafOptions = {},
): BhwFetchTransport {
  const maxAttempts = options.maxAttempts ?? 3;

  return {
    async fetch(
      url: string | URL,
      init?: BhwFetchInit,
    ): Promise<BhwFetchResponse> {
      let response = await session.fetch(url, init);
      let body: string | undefined;
      if (response.status === 403) body = await response.text();

      let attempts = 0;
      let lastError: unknown;
      while (
        body !== undefined &&
        isCloudflareChallenge(response.status, body) &&
        attempts < maxAttempts
      ) {
        attempts += 1;
        try {
          await clearCloudflareWaf(session, solver, {
            ...options,
            challengeHtml: body,
          });
        } catch (error) {
          // Solver-side flakes (transient 500s, "no challenge" races) count
          // as a failed attempt, not a fatal one.
          lastError = error;
          continue;
        }
        response = await session.fetch(url, init);
        body = response.status === 403 ? await response.text() : undefined;
      }

      if (
        body !== undefined &&
        isCloudflareChallenge(response.status, body)
      ) {
        throw lastError instanceof Error
          ? lastError
          : new BhwWafError(
              `Cloudflare WAF clearance failed after ${maxAttempts} attempts`,
            );
      }

      return body === undefined ? response : bufferBody(response, body);
    },
  };
}

/** Replay a response whose body was consumed for challenge detection. */
function bufferBody(
  response: BhwFetchResponse,
  body: string,
): BhwFetchResponse {
  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}
