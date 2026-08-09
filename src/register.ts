import { load } from "cheerio/slim";
import type { CheerioAPI } from "cheerio";

import type {
  CaptchaSolveOptions,
  CaptchaSolver,
  TurnstileChallenge,
} from "./captcha.js";
import {
  XF_AJAX_HEADERS,
  XF_FORM_HEADERS,
  extractXfToken,
  parseXfJson,
  withXfQuery,
  xfAjaxParams,
  xfErrorMessage,
  xfHasError,
  type XfAjaxParams,
} from "./xf2.js";
import type { BhwFetchTransport } from "./session.js";

/** BHW's Cloudflare Turnstile sitekey observed on registration and login. */
export const BHW_TURNSTILE_SITEKEY = "0x4AAAAAAA-kCmQPJ4mPfcHl" as const;

/** Standard Chromium User-Agent aligned with the browser profile in session.ts. */
export const DEFAULT_BHW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" as const;

/* ---------------------------------------------------------------------------
 * Registration input / result
 * ------------------------------------------------------------------------- */

export interface BhwRegistrationDob {
  readonly month: number;
  readonly day: number;
  readonly year: number;
}

export interface BhwRegistrationInput {
  readonly username: string;
  readonly email: string;
  readonly password?: string;
  readonly dob: BhwRegistrationDob;
  /** IANA timezone, e.g. `America/Los_Angeles`. Auto-detected from the form when omitted. */
  readonly timezone?: string;
}

export interface BhwRegistrationResult {
  /** Redirect URL after successful registration (typically `/register/complete`). */
  readonly redirect: string;
  readonly username: string;
}

/* ---------------------------------------------------------------------------
 * Form parsing
 * ------------------------------------------------------------------------- */

/** Semantic role of a control in BHW's registration form. */
export type BhwRegistrationFieldRole =
  | "xfToken"
  | "honeypot"
  | "username"
  | "email"
  | "emailConfirm"
  | "password"
  | "dobMonth"
  | "dobDay"
  | "dobYear"
  | "turnstile"
  | "accept"
  | "regKey"
  | "timezone"
  | "unknown";

/** One named control in the registration form, in DOM order. */
export interface BhwRegistrationFormField {
  readonly name: string;
  readonly type: string;
  readonly role: BhwRegistrationFieldRole;
  readonly defaultValue: string;
  readonly disabled: boolean;
}

/** Parsed registration form: DOM-ordered controls plus legacy named accessors. */
export interface BhwRegistrationForm {
  readonly xfToken: string;
  readonly usernameField: string;
  readonly emailField: string;
  readonly emailConfirmField: string;
  readonly passwordField: string;
  readonly timezoneField: string;
  readonly timezoneValue: string;
  readonly regKey: string;
  readonly turnstileSitekey: string;
  /** Widget's `data-action` — embedded into the Turnstile token and verified server-side. */
  readonly turnstileAction?: string;
  /**
   * Anti-bot submission timer from the form's `data-timer` attribute.
   * Submitting sooner than this many seconds after the form was rendered
   * routes the request to a decoy handler.
   */
  readonly submitDelaySeconds: number;
  /** Every named form control in DOM order — submission mirrors this exactly. */
  readonly fields: readonly BhwRegistrationFormField[];
}

/** Hex-obfuscated field names (20–40 chars) used to deter autofill bots. */
const OBFUSCATED_NAME = /^[0-9a-f]{16,}$/i;

/**
 * Parse the registration form HTML.
 *
 * Walks every named control in DOM order and assigns a semantic role from
 * name, autocomplete attribute, type, and label hints. BHW rotates form
 * variants — some include honeypot traps (plain `email`/`password` inputs,
 * extra autocomplete=off email fields) that real browsers leave empty and
 * naive bots fill. Submitting must mirror a real browser exactly: every
 * enabled named control, in DOM order, honeypots left at their default.
 */
export function parseBhwRegistrationForm(html: string): BhwRegistrationForm {
  const $ = load(html);

  const xfToken = extractXfToken(html);

  const regKey = $('input[name="reg_key"]').attr("value") ?? "";
  const sitekeyEl =
    $(".cf-turnstile[data-sitekey]").length > 0
      ? $(".cf-turnstile[data-sitekey]").first()
      : $("[data-sitekey]").first();
  const turnstileSitekey =
    sitekeyEl.attr("data-sitekey") ?? BHW_TURNSTILE_SITEKEY;
  const turnstileAction = sitekeyEl.attr("data-action") || undefined;

  const timerAttr =
    $('form[action*="register/register"]').attr("data-timer") ??
    $("form[data-timer]").first().attr("data-timer");
  const parsedTimer = timerAttr === undefined ? NaN : Number(timerAttr);
  const submitDelaySeconds = Number.isFinite(parsedTimer) ? parsedTimer : 15;

  const scoped = $('form[action*="register/register"]').first();
  const root = scoped.length > 0 ? scoped : $("form").last();
  const controls = root.length > 0 ? root.find("input, select") : $("input, select");

  const fields: BhwRegistrationFormField[] = [];
  let emailSeen = 0;
  controls.each((_, el) => {
    const name = $(el).attr("name") ?? "";
    if (name === "") return; // browsers never submit nameless controls
    const tag = el.tagName.toLowerCase();
    const type =
      tag === "select"
        ? "select"
        : ($(el).attr("type") ?? "text").toLowerCase();
    const autocomplete = ($(el).attr("autocomplete") ?? "").toLowerCase();
    const disabled = $(el).attr("disabled") !== undefined;
    const defaultValue = $(el).attr("value") ?? "";

    let role: BhwRegistrationFieldRole;
    if (name === "_xfToken") {
      role = "xfToken";
    } else if (name === "reg_key") {
      role = "regKey";
    } else if (name === "cf-turnstile-response") {
      role = "turnstile";
    } else if (name === "accept") {
      role = "accept";
    } else if (name === "dob_month") {
      role = "dobMonth";
    } else if (name === "dob_day") {
      role = "dobDay";
    } else if (name === "dob_year") {
      role = "dobYear";
    } else if (
      name === "username" ||
      name === "email" ||
      name === "password"
    ) {
      role = "honeypot"; // plain-name traps — humans never see these
    } else if (autocomplete === "username") {
      role = "username";
    } else if (autocomplete === "email") {
      role = emailSeen === 0 ? "email" : "emailConfirm";
      emailSeen += 1;
    } else if (
      autocomplete === "new-password" ||
      autocomplete === "current-password"
    ) {
      role = "password";
    } else if (type === "email" || type === "password") {
      role = "honeypot"; // extra autocomplete=off email/password traps
    } else if (hasTimezoneHint($, el)) {
      role = "timezone";
    } else if (type === "hidden" && OBFUSCATED_NAME.test(name)) {
      role = "timezone"; // XF2's obfuscated hidden timezone field
    } else {
      role = "unknown";
    }

    fields.push({ name, type, role, defaultValue, disabled });
  });

  const byRole = (role: BhwRegistrationFieldRole): string =>
    fields.find((field) => field.role === role)?.name ?? "";

  const usernameField = byRole("username");
  const emailField = byRole("email");
  const timezoneField = byRole("timezone");
  const timezoneValue =
    fields.find((field) => field.role === "timezone")?.defaultValue ||
    "UTC";

  if (!usernameField || !emailField) {
    throw new BhwRegistrationError(
      "Could not identify obfuscated username or email fields in the registration form",
    );
  }

  return {
    xfToken,
    usernameField,
    emailField,
    emailConfirmField: byRole("emailConfirm"),
    passwordField: byRole("password"),
    timezoneField,
    timezoneValue,
    regKey,
    turnstileSitekey,
    ...(turnstileAction === undefined ? {} : { turnstileAction }),
    submitDelaySeconds,
    fields,
  };
}

/** Check id/aria-label hints for the XF2 timezone field. */
function hasTimezoneHint(
  $: CheerioAPI,
  el: Parameters<CheerioAPI>[0],
): boolean {
  const $el = $(el);
  const id = ($el.attr("id") ?? "").toLowerCase();
  if (id.includes("timezone") || id.includes("time_zone")) return true;
  const labelledBy = $el.attr("aria-labelledby");
  if (labelledBy !== undefined) {
    const label = ($(`#${labelledBy}`).text() ?? "").toLowerCase();
    if (label.includes("timezone") || label.includes("time zone")) {
      return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Registration execution
 * ------------------------------------------------------------------------- */

export interface BhwRegisterOptions {
  readonly captchaSolver: CaptchaSolver<TurnstileChallenge>;
  readonly captchaSolveOptions?: CaptchaSolveOptions;
  /**
   * Minimum delay between form fetch and submission. BHW's anti-bot timer
   * (`data-timer`) decoys fast submissions; defaults to the form's timer
   * plus human jitter. Tests may set 0.
   */
  readonly minSubmitDelayMs?: number;
  readonly signal?: AbortSignal;
}

/** BHW rejected a registration or returned an unexpected response. */
export class BhwRegistrationError extends Error {
  override readonly name = "BhwRegistrationError";
}

/**
 * Register a new BHW account.
 *
 * Flow:
 * 1. Fetch the registration form overlay (XF2 JSON with embedded HTML).
 * 2. Parse obfuscated field names and the Turnstile widget sitekey.
 * 3. Solve the Turnstile challenge.
 * 4. Submit the registration as multipart form data.
 */
export async function registerBhwAccount(
  transport: BhwFetchTransport,
  origin: URL,
  input: BhwRegistrationInput,
  options: BhwRegisterOptions,
): Promise<BhwRegistrationResult> {
  const formHtml = await fetchRegistrationForm(transport, origin);
  // The reg_key (and the anti-bot timer) is anchored server-side when the
  // form is rendered — at or before this moment.
  const formRenderedAt = Date.now();
  const form = parseBhwRegistrationForm(formHtml);

  const challenge: TurnstileChallenge = {
    type: "turnstile",
    url: new URL("/register/", origin).href,
    sitekey: form.turnstileSitekey,
    ...(form.turnstileAction === undefined
      ? {}
      : { action: form.turnstileAction }),
  };
  const solution = await options.captchaSolver.solve(
    challenge,
    options.captchaSolveOptions,
  );
  if (solution.type !== "turnstile") {
    throw new BhwRegistrationError(
      `Expected Turnstile solution, got ${solution.type}`,
    );
  }

  // Respect BHW's anti-bot submission timer: submitting before the form's
  // data-timer elapses yields a decoy "Your changes have been saved."
  // response and never reaches the registration backend. A 2s margin plus
  // jitter absorbs the offset between this clock and the server-side anchor.
  const minDelayMs =
    options.minSubmitDelayMs ??
    (form.submitDelaySeconds + 2) * 1000 +
      Math.floor(Math.random() * 2000);
  const remaining = minDelayMs - (Date.now() - formRenderedAt);
  if (remaining > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, remaining);
    await promise;
  }
  options.signal?.throwIfAborted();

  const ajax = xfAjaxParams(form.xfToken, "/");
  const body = buildRegistrationFormData(form, input, solution.token, ajax);
  const response = await transport.fetch(
    new URL("/register/register", origin),
    {
      method: "POST",
      headers: {
        ...XF_FORM_HEADERS,
        origin: origin.href,
        referer: origin.href,
      },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

  const json = parseXfJson(await response.json());
  if (xfHasError(json)) {
    throw new BhwRegistrationError(
      `Registration rejected: ${xfErrorMessage(json)}`,
    );
  }

  const redirect =
    typeof json.redirect === "string"
      ? json.redirect
      : new URL("/register/complete", origin).href;

  // BHW's anti-bot filter returns a fake success — "Your changes have been
  // saved." with a redirect back to the form — when a submission is too fast
  // or the session is flagged. Real registrations redirect to
  // /register/complete and include a visitor payload.
  if (!redirect.includes("/register/complete")) {
    throw new BhwRegistrationError(
      `Registration was silently rejected (anti-bot decoy): ${typeof json.message === "string" ? json.message : "redirect to " + redirect}`,
    );
  }

  return { redirect, username: input.username };
}

async function fetchRegistrationForm(
  transport: BhwFetchTransport,
  origin: URL,
): Promise<string> {
  // Seed cookies and capture the page token — the overlay request is only
  // honored with a valid token (an empty one silently returns no HTML).
  const seedResponse = await transport.fetch(new URL("/", origin), {
    headers: { accept: "text/html" },
  });
  const pageToken = extractXfToken(await seedResponse.text());

  const url = withXfQuery(new URL("/register/", origin), pageToken, "/");
  let html = "";
  try {
    const response = await transport.fetch(url, { headers: XF_AJAX_HEADERS });
    const json = parseXfJson(await response.json());
    html =
      typeof json.html === "object" && json.html !== null &&
          "content" in json.html
        ? String((json.html as Record<string, unknown>).content)
        : typeof json.html === "string"
          ? json.html
          : "";
  } catch {
    // Overlay not available — fall through to direct page fetch.
  }
  if (html.length > 0) return html;

  // Fallback: fetch the registration page directly as HTML.
  const pageResponse = await transport.fetch(new URL("/register/", origin), {
    headers: { accept: "text/html" },
  });
  const pageHtml = await pageResponse.text();
  if (pageHtml.length === 0) {
    throw new BhwRegistrationError(
      "Registration form returned no HTML content (overlay and direct page both empty)",
    );
  }
  return pageHtml;
}

/**
 * Build multipart form data mirroring a real browser submission exactly:
 * every enabled named control in DOM order, honeypots left at their default
 * (empty) values, then the XF2 AJAX envelope appended by XF's ajax-submit
 * handler, with the session token repeated last — matching the observed HAR
 * of a successful registration.
 */
function buildRegistrationFormData(
  form: BhwRegistrationForm,
  input: BhwRegistrationInput,
  turnstileToken: string,
  ajax: XfAjaxParams,
): FormData {
  const requiresPassword = form.fields.some(
    (field) => field.role === "password" && !field.disabled,
  );
  if (requiresPassword && input.password === undefined) {
    throw new BhwRegistrationError(
      "The registration form requires a password, but none was provided",
    );
  }

  const data = new FormData();
  for (const field of form.fields) {
    if (field.disabled) continue; // browsers skip disabled controls
    switch (field.role) {
      case "xfToken":
        data.append(field.name, form.xfToken || field.defaultValue);
        break;
      case "honeypot":
        data.append(field.name, field.defaultValue); // humans leave these empty
        break;
      case "username":
        data.append(field.name, input.username);
        break;
      case "email":
      case "emailConfirm":
        data.append(field.name, input.email);
        break;
      case "password":
        data.append(field.name, input.password ?? "");
        break;
      case "dobMonth":
        data.append(field.name, String(input.dob.month));
        break;
      case "dobDay":
        data.append(field.name, String(input.dob.day));
        break;
      case "dobYear":
        data.append(field.name, String(input.dob.year));
        break;
      case "turnstile":
        data.append(field.name, turnstileToken);
        break;
      case "accept":
        data.append(field.name, field.defaultValue || "1");
        break;
      case "regKey":
        data.append(field.name, field.defaultValue);
        break;
      case "timezone":
        data.append(
          field.name,
          input.timezone ?? (field.defaultValue || form.timezoneValue),
        );
        break;
      case "unknown":
        data.append(field.name, field.defaultValue);
        break;
    }
  }
  // The widget injects cf-turnstile-response into the live DOM at render
  // time; when absent from the raw HTML, append it like XF's ajax-submit.
  const hasTurnstileField = form.fields.some(
    (field) => field.role === "turnstile" && !field.disabled,
  );
  if (!hasTurnstileField) {
    data.append("cf-turnstile-response", turnstileToken);
  }
  // XF2 AJAX envelope (ajax-submit appends these after the form controls).
  data.append("_xfResponseType", ajax._xfResponseType);
  data.append("_xfWithData", String(ajax._xfWithData));
  data.append("_xfRequestUri", ajax._xfRequestUri);
  data.append("_xfToken", form.xfToken);
  return data;
}

/* ---------------------------------------------------------------------------
 * Username validation
 * ------------------------------------------------------------------------- */

export interface BhwUsernameValidation {
  readonly available: boolean;
  readonly message?: string;
}

/**
 * Validate a username via BHW's live availability check.
 *
 * Calls `/misc/validate-username` with the obfuscated field name from the form.
 */
export async function validateBhwUsername(
  transport: BhwFetchTransport,
  origin: URL,
  usernameField: string,
  username: string,
  xfToken: string,
  signal?: AbortSignal,
): Promise<BhwUsernameValidation> {
  const body = {
    field: usernameField,
    content: username,
    _xfResponseType: "json",
    _xfWithData: 1,
    _xfRequestUri: "/",
    _xfToken: xfToken,
  };

  const response = await transport.fetch(
    new URL("/misc/validate-username", origin),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    },
  );

  const json = parseXfJson(await response.json());
  const status = typeof json.status === "string" ? json.status : "";
  if (status === "error") {
    return { available: false, message: xfErrorMessage(json) };
  }
  return { available: true };
}
