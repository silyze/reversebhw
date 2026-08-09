/**
 * Universal CAPTCHA / bot-challenge boundary.
 *
 * BlackHatWorld sits behind Cloudflare Turnstile and WAF challenges.
 * This module defines solver-neutral challenge and solution types so the
 * registration and login flows never hard-code a provider.
 */

/* ---------------------------------------------------------------------------
 * Challenges
 * ------------------------------------------------------------------------- */

/** Cloudflare Turnstile widget embedded in BHW's registration and login forms. */
export interface TurnstileChallenge {
  readonly type: "turnstile";
  /** Page URL where the widget appears. */
  readonly url: string;
  /** Turnstile sitekey from the widget's `data-sitekey` attribute. */
  readonly sitekey: string;
  /** Optional `action` bound to the token. */
  readonly action?: string;
  /** Optional `cdata` bound to the token. */
  readonly cdata?: string;
}

/** Cloudflare WAF challenge — solver returns clearance to use in a follow-up request. */
export interface CloudflareWafChallenge {
  readonly type: "cloudflare-waf";
  /** URL that returned the Cloudflare challenge response. */
  readonly url: string;
  /** Sticky proxy used for the original and follow-up requests. */
  readonly proxy?: string;
  /** User-Agent from the challenged client. */
  readonly userAgent?: string;
  /** Challenge response HTML captured from the browser. */
  readonly html?: string;
}

/** Cloudflare WAF Auto — solver fetches the protected response itself. */
export interface CloudflareWafAutoChallenge {
  readonly type: "cloudflare-waf-auto";
  /** URL that returned the Cloudflare challenge response. */
  readonly url: string;
  /** Sticky proxy used for the original and follow-up requests. */
  readonly proxy: string;
  /** User-Agent from the challenged client. */
  readonly userAgent?: string;
}

/** CAPTCHA challenges currently understood by the SDK. */
export type CaptchaChallenge =
  | TurnstileChallenge
  | CloudflareWafChallenge
  | CloudflareWafAutoChallenge;

/* ---------------------------------------------------------------------------
 * Solutions
 * ------------------------------------------------------------------------- */

/** Solution for a Turnstile challenge — a single verification token. */
export interface TurnstileSolution {
  readonly type: "turnstile";
  readonly token: string;
}

/**
 * Solution for a WAF challenge.
 *
 * Apply `clearance` as the `cf_clearance` cookie, `cfBm` as `__cf_bm`, and
 * reuse `headers` exactly (especially user-agent and Client Hints).
 */
export interface CloudflareWafSolution {
  readonly type: "cloudflare-waf";
  readonly clearance: string;
  readonly cfBm: string | null;
  readonly cfRt: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Form fields for the first follow-up POST. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** Solution for a WAF Auto challenge — clearance plus the fetched response body. */
export interface CloudflareWafAutoSolution {
  readonly type: "cloudflare-waf-auto";
  readonly clearance: string;
  readonly cfBm: string | null;
  readonly cfRt: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Base64-decoded response body from the protected URL. */
  readonly body: string;
}

export type CaptchaSolution =
  | TurnstileSolution
  | CloudflareWafSolution
  | CloudflareWafAutoSolution;

/* ---------------------------------------------------------------------------
 * Solver interface
 * ------------------------------------------------------------------------- */

/** Per-attempt controls shared by all solver implementations. */
export interface CaptchaSolveOptions {
  /** Proxy URL the solver should use for the challenge worker. */
  readonly proxy?: string;
  readonly signal?: AbortSignal;
}

/**
 * Pluggable CAPTCHA boundary.
 *
 * Implement this interface to use a hosted service, a browser-assisted solver,
 * or a test double without coupling BHW's flows to that implementation.
 */
export interface CaptchaSolver<
  TChallenge extends CaptchaChallenge = CaptchaChallenge,
> {
  solve(
    challenge: TChallenge,
    options?: CaptchaSolveOptions,
  ): Promise<CaptchaSolution>;
}
