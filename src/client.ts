import type {
  CaptchaSolveOptions,
  CaptchaSolver,
  TurnstileChallenge,
} from "./captcha.js";
import type { BhwFetchTransport, BhwSession } from "./session.js";
import {
  createBhwSession,
  type BhwCookieInput,
  type BhwProxy,
  type BhwSessionOptions,
} from "./session.js";
import { wafResilientTransport } from "./waf.js";
import type { BrowserProfile, EmulationOS } from "wreq-js";
import {
  parseXfJson,
  withXfQuery,
  XF_AJAX_HEADERS,
  xfErrorMessage,
  xfHasError,
  extractXfToken,
} from "./xf2.js";
import {
  BHW_TURNSTILE_SITEKEY,
  parseBhwRegistrationForm,
  registerBhwAccount,
  validateBhwUsername,
  type BhwRegistrationInput,
  type BhwRegistrationResult,
  type BhwRegisterOptions,
  type BhwRegistrationForm,
  type BhwUsernameValidation,
} from "./register.js";
import {
  BhwLoginError,
  loginBhwAccount,
  type BhwLoginInput,
  type BhwLoginOptions,
  type BhwLoginResult,
} from "./login.js";
import {
  BhwWhatsNewError,
  fetchBhwWhatsNew,
  type BhwWhatsNewOptions,
  type BhwWhatsNewPage,
} from "./whatsnew.js";
import {
  fetchBhwSearch,
  type BhwSearchOptions,
  type BhwSearchPage,
} from "./search.js";
import {
  fetchBhwThread,
  replyToBhwThread,
  saveBhwDraft,
  BhwThreadError,
  type BhwDraftInput,
  type BhwFetchThreadOptions,
  type BhwPagination,
  type BhwReplyInput,
  type BhwReplyResult,
  type BhwThread,
  type BhwThreadPage,
  type BhwThreadPost,
} from "./thread.js";
import {
  createBhwThread,
  fetchBhwThreadCreationForm,
  type BhwCreateThreadInput,
  type BhwCreateThreadResult,
  type BhwThreadCreationForm,
} from "./create-thread.js";
import {
  deleteBhwPost,
  editBhwPost,
  quoteBhwPost,
  reactToBhwPost,
  reportBhwPost,
  type BhwDeletePostInput,
  type BhwEditPostInput,
  type BhwEditPostResult,
  type BhwQuoteInput,
  type BhwQuoteResult,
  type BhwReactInput,
  type BhwReactResult,
  type BhwReactionId,
  type BhwReportPostInput,
} from "./post.js";

/* ---------------------------------------------------------------------------
 * Client options
 * ------------------------------------------------------------------------- */

export interface BhwClientOptions {
  /**
   * Use an existing session (e.g. restored from cookies) instead of creating
   * a new one. When omitted a new browser-grade session is created.
   */
  readonly session?: BhwSession;
  /** Session configuration when creating a new session internally. */
  readonly sessionOptions?: BhwSessionOptions;
  /** Proxy shortcut — merged into `sessionOptions` and the Uncaptcha solver. */
  readonly proxy?: BhwProxy;
  /** Browser emulation shortcut — merged into `sessionOptions`. */
  readonly browser?: BrowserProfile;
  /** OS emulation shortcut — merged into `sessionOptions`. */
  readonly os?: EmulationOS;
  /** Request timeout shortcut — merged into `sessionOptions`. */
  readonly timeoutMs?: number;
  /**
   * Resume a session from exported cookies (browser export or a previous
   * {@link BhwClient.exportCookies} result). Merged into `sessionOptions`.
   */
  readonly cookies?: readonly BhwCookieInput[] | string;
  /** CAPTCHA solver for Turnstile and WAF challenges. */
  readonly captchaSolver?: CaptchaSolver;
  /** Default solve options forwarded to the solver on every challenge. */
  readonly captchaSolveOptions?: CaptchaSolveOptions;
  /** Max WAF solve-and-retry cycles per request (default 3). */
  readonly wafAttempts?: number;
}

/* ---------------------------------------------------------------------------
 * BhwClient
 * ------------------------------------------------------------------------- */

/**
 * Authenticated entry point that owns one persistent BHW session.
 *
 * Wraps registration, login, thread, and post operations behind a single
 * cohesive API while delegating the actual HTTP to a `BhwSession`.
 */
export class BhwClient {
  readonly #session: BhwSession;
  readonly #transport: BhwFetchTransport;
  readonly #captchaSolver: CaptchaSolver | undefined;
  readonly #captchaSolveOptions: CaptchaSolveOptions | undefined;
  #xfToken: string | undefined;
  #ownsSession: boolean;

  constructor(options: {
    readonly session: BhwSession;
    readonly captchaSolver?: CaptchaSolver;
    readonly captchaSolveOptions?: CaptchaSolveOptions;
    readonly wafAttempts?: number;
    readonly ownsSession?: boolean;
  }) {
    this.#session = options.session;
    this.#ownsSession = options.ownsSession ?? true;
    this.#captchaSolver = options.captchaSolver;
    this.#captchaSolveOptions = options.captchaSolveOptions;
    // When a solver is available, every request gains transparent Cloudflare
    // WAF clearance — interstitials are solved and retried invisibly.
    this.#transport =
      options.captchaSolver === undefined
        ? options.session
        : wafResilientTransport(options.session, options.captchaSolver, {
            ...(options.wafAttempts === undefined
              ? {}
              : { maxAttempts: options.wafAttempts }),
          });
  }

  /**
   * Create a client with a new browser-grade session.
   *
   * Minimal form: `BhwClient.create({ proxy, captchaSolver })` — session and
   * WAF resilience are wired automatically; any {@link CaptchaSolver}
   * implementation plugs in (see `src/solvers/` for adapters).
   */
  static async create(options: BhwClientOptions = {}): Promise<BhwClient> {
    const session =
      options.session !== undefined
        ? options.session
        : await createBhwSession({
            ...(options.sessionOptions ?? {}),
            ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
            ...(options.browser === undefined
              ? {}
              : { browser: options.browser }),
            ...(options.os === undefined ? {} : { os: options.os }),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
            ...(options.cookies === undefined
              ? {}
              : { cookies: options.cookies }),
          });

    return new BhwClient({
      session,
      ...(options.captchaSolver === undefined
        ? {}
        : { captchaSolver: options.captchaSolver }),
      ...(options.captchaSolveOptions === undefined
        ? {}
        : { captchaSolveOptions: options.captchaSolveOptions }),
      ...(options.wafAttempts === undefined
        ? {}
        : { wafAttempts: options.wafAttempts }),
      ownsSession: options.session === undefined,
    });
  }

  get origin(): URL {
    return this.#session.origin;
  }

  get transport(): BhwFetchTransport {
    return this.#transport;
  }

  /** Current XF2 CSRF token, or `undefined` before the first page load. */
  get xfToken(): string | undefined {
    return this.#xfToken;
  }

  /* -------------------------------------------------------------------------
   * Session
   * --------------------------------------------------------------------- */

  /**
   * Ensure a CSRF token is available.
   *
   * Fetches the home page if no token has been extracted yet. Safe to call
   * multiple times — only the first missing token triggers a request.
   */
  async ensureToken(signal?: AbortSignal): Promise<string> {
    if (this.#xfToken !== undefined) return this.#xfToken;
    const html = await this.#fetchHtml("/", signal);
    this.#xfToken = extractXfToken(html);
    return this.#xfToken;
  }

  /**
   * Export the session's cookies for persisting or resuming later.
   *
   * Feed the result back via `BhwClient.create({ cookies })` or
   * `createBhwSession({ cookies })`. Note `cf_clearance` is IP-bound —
   * reuse it through the same proxy egress.
   */
  exportCookies(): BhwCookieInput[] {
    if (this.#session.getCookies === undefined) {
      throw new TypeError(
        "This session does not expose cookies (custom BhwSession without getCookies)",
      );
    }
    return Object.entries(this.#session.getCookies()).map(
      ([name, value]) => ({ name, value }),
    );
  }

  /** Close the underlying session if the client owns it. */
  async close(): Promise<void> {
    if (this.#ownsSession) {
      await this.#session.close();
    }
  }

  /* -------------------------------------------------------------------------
   * Registration
   * --------------------------------------------------------------------- */

  /**
   * Register a new BHW account.
   *
   * Requires a `captchaSolver` capable of solving Turnstile challenges.
   */
  async register(
    input: BhwRegistrationInput,
    options?: Omit<BhwRegisterOptions, "captchaSolver">,
  ): Promise<BhwRegistrationResult> {
    this.#requireSolver();
    return registerBhwAccount(this.#transport, this.origin, input, {
      captchaSolver: this.#captchaSolver!,
      ...(this.#captchaSolveOptions === undefined
        ? {}
        : { captchaSolveOptions: this.#captchaSolveOptions }),
      ...(options ?? {}),
    });
  }

  /**
   * Visit a registration email-confirmation link through this session.
   *
   * Cloudflare interstitials are cleared transparently when a solver is
   * configured. Returns `true` when BHW reports the account as confirmed.
   */
  async confirmEmail(
    url: string | URL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.#transport.fetch(url, {
      ...(signal === undefined ? {} : { signal }),
    });
    const html = await response.text();
    return (
      html.includes("registration is now complete") ||
      html.includes("email has been confirmed")
    );
  }

  /**
   * Fetch and parse the registration form (useful for pre-validation).
   *
   * Returns the parsed form including obfuscated field names.
   */
  async fetchRegistrationForm(
    signal?: AbortSignal,
  ): Promise<BhwRegistrationForm> {
    const html = await this.#fetchOverlay("/register/", "/", signal);
    return parseBhwRegistrationForm(html);
  }

  /** Check username availability via BHW's live validator. */
  async validateUsername(
    form: BhwRegistrationForm,
    username: string,
    signal?: AbortSignal,
  ): Promise<BhwUsernameValidation> {
    return validateBhwUsername(
      this.#transport,
      this.origin,
      form.usernameField,
      username,
      form.xfToken,
      signal,
    );
  }

  /* -------------------------------------------------------------------------
   * Login
   * --------------------------------------------------------------------- */

  /** Authenticate an existing BHW account. */
  async login(
    input: BhwLoginInput,
    options?: Omit<BhwLoginOptions, "captchaSolver">,
  ): Promise<BhwLoginResult> {
    const result = await loginBhwAccount(this.#transport, this.origin, input, {
      ...(this.#captchaSolver === undefined
        ? {}
        : { captchaSolver: this.#captchaSolver }),
      ...(this.#captchaSolveOptions === undefined
        ? {}
        : { captchaSolveOptions: this.#captchaSolveOptions }),
      ...(options ?? {}),
    });
    // After login, seed the CSRF token from the redirected page.
    this.#xfToken = undefined;
    return result;
  }

  /* -------------------------------------------------------------------------
   * What's new feed
   * --------------------------------------------------------------------- */

  /**
   * Fetch the "What's new → posts" feed (recently bumped threads).
   *
   * BHW caps the feed at 10 pages. For pages beyond the first, pass the
   * `resultSetId` from the page-1 response — it rotates between crawls.
   */
  async whatsNew(options: BhwWhatsNewOptions = {}): Promise<BhwWhatsNewPage> {
    const page = await fetchBhwWhatsNew(this.#transport, this.origin, options);
    this.#xfToken = page.xfToken;
    return page;
  }

  /* -------------------------------------------------------------------------
   * Search
   * --------------------------------------------------------------------- */

  /**
   * Search BHW for matching threads via XenForo's standard read-only GET
   * endpoint. This works for public pages as well as the client's current
   * authenticated session, when one exists.
   */
  async search(
    keywords: string,
    options: BhwSearchOptions = {},
  ): Promise<BhwSearchPage> {
    const token = await this.ensureToken(options.signal);
    const page = await fetchBhwSearch(
      this.#transport,
      this.origin,
      keywords,
      options,
      token,
    );
    this.#xfToken = page.xfToken;
    return page;
  }

  /* -------------------------------------------------------------------------
   * Thread operations
   * --------------------------------------------------------------------- */

  /**
   * Fetch and parse a thread page.
   *
   * The slug is optional (XF2 canonicalizes); pass `page` to paginate.
   * Updates the client's CSRF token from the response.
   */
  async viewThread(
    threadId: number,
    options: BhwFetchThreadOptions = {},
  ): Promise<BhwThreadPage> {
    const page = await fetchBhwThread(
      this.#transport,
      this.origin,
      threadId,
      options,
    );
    this.#xfToken = page.xfToken;
    return page;
  }

  /**
   * Post a reply to a thread.
   *
   * Ensures a CSRF token is available before submitting. Pass a `BhwThreadPage`
   * from `viewThread` via the `lastDate` and `attachmentHash` fields for
   * correct live-update diffing.
   */
  async reply(input: BhwReplyInput): Promise<BhwReplyResult> {
    const token = await this.ensureToken(input.signal);
    return replyToBhwThread(this.#transport, this.origin, token, input);
  }

  /** Save a reply draft for a thread. */
  async saveDraft(input: BhwDraftInput): Promise<void> {
    const token = await this.ensureToken(input.signal);
    return saveBhwDraft(this.#transport, this.origin, token, input);
  }

  /**
   * Create a new thread in an explicitly supplied BHW forum.
   *
   * The forum URL may be a forum landing page or its direct new-thread
   * composer. The live composer is fetched first so its current CSRF token,
   * action URL, and hidden defaults are submitted intact.
   */
  async createThread(
    input: BhwCreateThreadInput,
  ): Promise<BhwCreateThreadResult> {
    return createBhwThread(this.#transport, this.origin, input);
  }

  /** Fetch the live new-thread composer metadata for a BHW forum. */
  async fetchThreadCreationForm(
    forumUrl: string | URL,
    signal?: AbortSignal,
  ): Promise<BhwThreadCreationForm> {
    return fetchBhwThreadCreationForm(
      this.#transport,
      this.origin,
      forumUrl,
      signal,
    );
  }

  /* -------------------------------------------------------------------------
   * Post operations
   * --------------------------------------------------------------------- */

  /** Toggle a reaction on a post. */
  async react(input: BhwReactInput): Promise<BhwReactResult> {
    const token = await this.ensureToken(input.signal);
    return reactToBhwPost(this.#transport, this.origin, token, input);
  }

  /** Fetch the quote HTML for a post. */
  async quote(input: BhwQuoteInput): Promise<BhwQuoteResult> {
    const token = await this.ensureToken(input.signal);
    return quoteBhwPost(this.#transport, this.origin, token, input);
  }

  /** Edit an existing post. */
  async editPost(input: BhwEditPostInput): Promise<BhwEditPostResult> {
    const token = await this.ensureToken(input.signal);
    return editBhwPost(this.#transport, this.origin, token, input);
  }

  /** Delete (soft or hard) an existing post. */
  async deletePost(input: BhwDeletePostInput): Promise<void> {
    const token = await this.ensureToken(input.signal);
    return deleteBhwPost(this.#transport, this.origin, token, input);
  }

  /** Report a post to moderators. */
  async reportPost(input: BhwReportPostInput): Promise<void> {
    const token = await this.ensureToken(input.signal);
    return reportBhwPost(this.#transport, this.origin, token, input);
  }

  /* -------------------------------------------------------------------------
   * Internals
   * --------------------------------------------------------------------- */

  #requireSolver(): void {
    if (this.#captchaSolver === undefined) {
      throw new TypeError(
        "A captchaSolver is required for this operation. Pass one via BhwClientOptions.",
      );
    }
  }

  async #fetchHtml(path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#transport.fetch(new URL(path, this.origin), {
      headers: { accept: "text/html" },
      ...(signal === undefined ? {} : { signal }),
    });
    const html = await response.text();
    if (html.includes("Just a moment") || html.includes("cf-challenge")) {
      throw new BhwLoginError(
        "BHW returned a Cloudflare challenge — a WAF solver is required",
      );
    }
    return html;
  }

  async #fetchOverlay(
    path: string,
    requestUri: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = withXfQuery(
      new URL(path, this.origin),
      this.#xfToken ?? "",
      requestUri,
    );
    const response = await this.#transport.fetch(url, {
      headers: XF_AJAX_HEADERS,
      ...(signal === undefined ? {} : { signal }),
    });
    const json = parseXfJson(await response.json());
    const html =
      typeof json.html === "object" && json.html !== null &&
          "content" in json.html
        ? String((json.html as Record<string, unknown>).content)
        : typeof json.html === "string"
          ? json.html
          : "";
    if (html.length === 0) {
      throw new BhwThreadError(
        `XF2 overlay at ${path} returned no HTML content`,
      );
    }
    return html;
  }
}

