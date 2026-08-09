import type {
  CaptchaChallenge,
  CaptchaSolution,
  CaptchaSolveOptions,
  CaptchaSolver,
  CloudflareWafAutoChallenge,
  CloudflareWafChallenge,
  TurnstileChallenge,
} from "../captcha.js";

const DEFAULT_ENDPOINT = "https://api.uncaptcha.io/";
const DEFAULT_TIMEOUT_MS = 30_000;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface UncaptchaOptions {
  readonly apiKey: string;
  readonly endpoint?: string | URL;
  readonly fetch?: Fetch;
  readonly proxy?: string;
  readonly timeoutMs?: number;
}

/** uncaptcha.io returned an error or a response that violated its API contract. */
export class UncaptchaError extends Error {
  override readonly name = "UncaptchaError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * uncaptcha.io adapter for Cloudflare Turnstile and WAF challenges.
 *
 * Uses the synchronous `/v1/task/execute` endpoint: the request stays open
 * until the solver returns a solution or the execution limit is reached.
 */
export class Uncaptcha
  implements
    CaptchaSolver<TurnstileChallenge>,
    CaptchaSolver<CloudflareWafChallenge>,
    CaptchaSolver<CloudflareWafAutoChallenge>,
    CaptchaSolver
{
  readonly #apiKey: string;
  readonly #endpoint: URL;
  readonly #fetch: Fetch;
  readonly #proxy: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: UncaptchaOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new TypeError("Uncaptcha API key cannot be empty");
    }

    this.#apiKey = options.apiKey;
    this.#endpoint = endpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#proxy = nonEmptyOptional(options.proxy, "Uncaptcha proxy");
    this.#timeoutMs = positiveDuration(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Uncaptcha timeout",
    );
  }

  async solve(
    challenge: CaptchaChallenge,
    options: CaptchaSolveOptions = {},
  ): Promise<CaptchaSolution> {
    options.signal?.throwIfAborted();

    const proxy = options.proxy === undefined ? this.#proxy : options.proxy;
    const { taskType, taskData } = buildTask(challenge, proxy);

    const response = await this.#execute(taskType, taskData, options.signal);
    return parseSolution(challenge, response);
  }

  async #execute(
    taskType: string,
    taskData: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    const combinedSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);

    try {
      const response = await this.#fetch(
        new URL("v1/task/execute", this.#endpoint),
        {
          method: "POST",
          headers: {
            "x-api-key": this.#apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ task_type: taskType, task_data: taskData }),
          ...(combinedSignal === undefined ? {} : { signal: combinedSignal }),
        },
      );

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new UncaptchaError(
          `uncaptcha.io returned non-JSON status ${response.status}`,
        );
      }
      if (!isRecord(body)) {
        throw new UncaptchaError("uncaptcha.io returned an invalid body");
      }

      if (!body.success) {
        const message = stringProperty(body, "message") ??
          "unknown uncaptcha.io error";
        throw new UncaptchaError(
          `${response.status}: ${message}`,
          `HTTP_${response.status}`,
        );
      }

      const data = body.data;
      if (!isRecord(data)) {
        throw new UncaptchaError("uncaptcha.io response missing data object");
      }

      const solution = data.solution;
      if (!isRecord(solution)) {
        throw new UncaptchaError(
          "uncaptcha.io response missing solution object",
        );
      }

      return solution;
    } catch (error) {
      if (error instanceof UncaptchaError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        if (signal?.aborted) throw error;
        throw new UncaptchaError(
          `uncaptcha.io did not finish within ${this.#timeoutMs}ms`,
          "TIMEOUT",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* ---------------------------------------------------------------------------
 * Task builders
 * ------------------------------------------------------------------------- */

function buildTask(
  challenge: CaptchaChallenge,
  proxy: string | undefined,
): {
  taskType: string;
  taskData: Record<string, unknown>;
} {
  switch (challenge.type) {
    case "turnstile":
      return turnstileTask(challenge, proxy);
    case "cloudflare-waf":
      return wafTask(challenge);
    case "cloudflare-waf-auto":
      return wafAutoTask(challenge);
  }
}

function turnstileTask(
  challenge: TurnstileChallenge,
  proxy: string | undefined,
): { taskType: string; taskData: Record<string, unknown> } {
  const taskData: Record<string, unknown> = {
    url: challenge.url,
    sitekey: challenge.sitekey,
  };
  if (proxy) taskData.proxy = proxy;
  if (challenge.action) taskData.action = challenge.action;
  if (challenge.cdata) taskData.cdata = challenge.cdata;
  return { taskType: "turnstile", taskData };
}

function wafTask(challenge: CloudflareWafChallenge): {
  taskType: string;
  taskData: Record<string, unknown>;
} {
  const taskData: Record<string, unknown> = {
    url: challenge.url,
  };
  if (challenge.proxy) taskData.proxy = challenge.proxy;
  if (challenge.userAgent) taskData.user_agent = challenge.userAgent;
  if (challenge.html) taskData.html = challenge.html;
  return { taskType: "waf", taskData };
}

function wafAutoTask(challenge: CloudflareWafAutoChallenge): {
  taskType: string;
  taskData: Record<string, unknown>;
} {
  const taskData: Record<string, unknown> = {
    url: challenge.url,
    proxy: challenge.proxy,
  };
  if (challenge.userAgent) taskData.user_agent = challenge.userAgent;
  return { taskType: "wafauto", taskData };
}

/* ---------------------------------------------------------------------------
 * Solution parsers
 * ------------------------------------------------------------------------- */

function parseSolution(
  challenge: CaptchaChallenge,
  solution: Record<string, unknown>,
): CaptchaSolution {
  switch (challenge.type) {
    case "turnstile":
      return parseTurnstileSolution(solution);
    case "cloudflare-waf":
      return parseWafSolution(solution);
    case "cloudflare-waf-auto":
      return parseWafAutoSolution(solution);
  }
}

function parseTurnstileSolution(
  solution: Record<string, unknown>,
): CaptchaSolution {
  const token = stringProperty(solution, "token");
  if (token === undefined) {
    throw new UncaptchaError("uncaptcha.io Turnstile solution missing token");
  }
  return { type: "turnstile", token };
}

function parseWafSolution(solution: Record<string, unknown>): CaptchaSolution {
  const clearance = stringProperty(solution, "clearance");
  if (clearance === undefined) {
    throw new UncaptchaError("uncaptcha.io WAF solution missing clearance");
  }
  return {
    type: "cloudflare-waf",
    clearance,
    cfBm: stringProperty(solution, "cf_bm") ?? null,
    cfRt: stringProperty(solution, "cf_rt") ?? null,
    headers: stringRecord(solution, "headers"),
    attributes: stringRecord(solution, "attributes"),
  };
}

function parseWafAutoSolution(
  solution: Record<string, unknown>,
): CaptchaSolution {
  const clearance = stringProperty(solution, "clearance");
  if (clearance === undefined) {
    throw new UncaptchaError(
      "uncaptcha.io WAF Auto solution missing clearance",
    );
  }
  return {
    type: "cloudflare-waf-auto",
    clearance,
    cfBm: stringProperty(solution, "cf_bm") ?? null,
    cfRt: stringProperty(solution, "cf_rt") ?? null,
    headers: stringRecord(solution, "headers"),
    body: atobSafe(stringProperty(solution, "base64_body") ?? ""),
  };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function endpoint(value: string | URL): URL {
  if (value instanceof URL) return new URL(value);
  const url = new URL(value);
  if (!url.protocol.startsWith("http")) {
    throw new TypeError(`Uncaptcha endpoint must be http(s): ${value}`);
  }
  return url;
}

function nonEmptyOptional(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${name} cannot be empty or whitespace`);
  }
  return trimmed;
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const property = value[name];
  return typeof property === "string" ? property : undefined;
}

function stringRecord(
  value: Record<string, unknown>,
  name: string,
): Readonly<Record<string, string>> {
  const property = value[name];
  if (!isRecord(property)) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(property)) {
    if (typeof val === "string") result[key] = val;
  }
  return result;
}

function atobSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return value;
  }
}
