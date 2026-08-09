import {
  createSession,
  type BrowserProfile,
  type EmulationOS,
  type Response,
  type RequestInit as WreqRequestInit,
} from "wreq-js";

/** Browser identity observed during protocol discovery and used for BHW. */
export const DEFAULT_BHW_BROWSER_PROFILE = "chrome_149" as const;
export const DEFAULT_BHW_BROWSER_OS = "windows" as const;

/** Origin for all BlackHatWorld requests. */
export const DEFAULT_BHW_ORIGIN = "https://www.blackhatworld.com/" as const;

/** Proxy URL accepted by BHW's persistent HTTP session. */
export type BhwProxy = string | URL;

/** Cookie to seed into a session's jar (e.g. exported from a real browser). */
export interface BhwCookieInput {
  readonly name: string;
  readonly value: string;
}

/**
 * Parse a `name=value; name2=value2` cookie string (the `document.cookie`
 * and Cookie-Editor "header string" export formats).
 */
export function parseCookieString(cookieString: string): BhwCookieInput[] {
  const cookies: BhwCookieInput[] = [];
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) cookies.push({ name, value });
  }
  return cookies;
}

export interface BhwSessionOptions {
  readonly browser?: BrowserProfile;
  readonly os?: EmulationOS;
  /**
   * Session-wide HTTP(S) or SOCKS proxy. Curl-style values without a scheme
   * are interpreted as HTTP proxies.
   */
  readonly proxy?: BhwProxy;
  readonly timeoutMs?: number;
  /**
   * Cookies to seed the jar with — resume a browser session without
   * logging in programmatically. Accepts `{name, value}[]` (Cookie-Editor
   * JSON) or a `name=value; …` header string. Scoped to the BHW origin.
   */
  readonly cookies?: readonly BhwCookieInput[] | string;
}

/** Emulation and proxy configuration captured when the session was created. */
export interface BhwSessionConfig {
  readonly browser: BrowserProfile;
  readonly os: EmulationOS;
  readonly proxy?: string;
}

/** Request init accepted by BHW fetch operations (structurally compatible with wreq-js). */
export interface BhwFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | FormData | null;
  readonly signal?: AbortSignal | null;
}

export interface BhwFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface BhwFetchTransport {
  fetch(url: string | URL, init?: BhwFetchInit): Promise<BhwFetchResponse>;
}

/** Persistent browser-grade HTTP session used by all BHW clients. */
export interface BhwSession extends BhwFetchTransport {
  /** The origin all relative URLs resolve against. */
  readonly origin: URL;
  /** Emulation/proxy configuration, when created via {@link createBhwSession}. */
  readonly config?: BhwSessionConfig;
  /** Store a cookie scoped to this session's origin (needed for WAF clearance). */
  setCookie?(name: string, value: string): void;
  /** Read all cookies scoped to this session's origin. */
  getCookies?(): Record<string, string>;
  /** Close the underlying HTTP session and release its resources. */
  close(): Promise<void>;
}

/** Create one browser identity and cookie jar for a complete BHW session. */
export async function createBhwSession(
  options: BhwSessionOptions = {},
): Promise<BhwSession> {
  const browser = options.browser ?? DEFAULT_BHW_BROWSER_PROFILE;
  const os = options.os ?? DEFAULT_BHW_BROWSER_OS;
  const proxy =
    options.proxy === undefined ? undefined : normalizeBhwProxy(options.proxy);

  const session = await createSession({
    browser,
    os,
    ...(proxy === undefined ? {} : { proxy }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });

  const origin = new URL(DEFAULT_BHW_ORIGIN);

  if (options.cookies !== undefined) {
    const seeded =
      typeof options.cookies === "string"
        ? parseCookieString(options.cookies)
        : options.cookies;
    for (const cookie of seeded) {
      session.setCookie(cookie.name, cookie.value, origin);
    }
  }

  return {
    origin,
    config: {
      browser,
      os,
      ...(proxy === undefined ? {} : { proxy }),
    },
    setCookie(name: string, value: string): void {
      session.setCookie(name, value, origin);
    },
    getCookies(): Record<string, string> {
      return session.getCookies(origin.href);
    },
    async fetch(
      url: string | URL,
      init?: BhwFetchInit,
    ): Promise<Response> {
      const wreqInit: WreqRequestInit = init === undefined
        ? {}
        : {
            ...(init.method === undefined ? {} : { method: init.method }),
            ...(init.headers === undefined ? {} : { headers: init.headers }),
            ...(init.body === undefined || init.body === null
              ? {}
              : { body: init.body }),
            ...(init.signal === undefined || init.signal === null
              ? {}
              : { signal: init.signal }),
          };
      return session.fetch(
        url instanceof URL ? url.href : resolveUrl(url, origin),
        wreqInit,
      );
    },
    async close(): Promise<void> {
      await session.close();
    },
  };
}

/** Normalize proxy URLs without ever including credentials in validation errors. */
export function normalizeBhwProxy(proxy: BhwProxy): string {
  if (proxy instanceof URL) return proxy.href;
  if (!hasScheme(proxy)) return new URL(`http://${proxy}`).href;
  return new URL(proxy).href;
}

function resolveUrl(path: string, origin: URL): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return new URL(path, origin).href;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}
