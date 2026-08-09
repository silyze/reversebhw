import { describe, test, expect } from "bun:test";

import {
  BhwRegistrationError,
  BHW_TURNSTILE_SITEKEY,
  parseBhwRegistrationForm,
} from "../src/register.js";

const SHA1_USERNAME = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const SHA1_EMAIL = "0123456789abcdef0123456789abcdef01234567";
const SHA1_EMAIL_CONFIRM = "fedcba9876543210fedcba9876543210fedcba98";
const SHA1_TIMEZONE = "9999aaaabbbbccccddddeeeeffff000011112222";

function registrationFormHtml(
  overrides: Partial<{
    usernameAutocomplete: string;
    emailAutocomplete: string;
    includeRegKey: boolean;
    sitekey: string;
    timezoneValue: string;
  }> = {},
): string {
  const opts = {
    usernameAutocomplete: "username",
    emailAutocomplete: "email",
    includeRegKey: true,
    sitekey: "0x4AAAAAAA-kCmQPJ4mPfcHl",
    timezoneValue: "America/New_York",
    ...overrides,
  };
  return `
  <html><body>
  <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
  ${opts.includeRegKey ? `<input type="hidden" name="reg_key" value="reg_abc123xyz">` : ""}
  <div class="cf-turnstile" data-sitekey="${opts.sitekey}"></div>
  <form>
    <input type="text" name="${SHA1_USERNAME}" autocomplete="${opts.usernameAutocomplete}" id="username_field">
    <input type="email" name="${SHA1_EMAIL}" autocomplete="${opts.emailAutocomplete}" id="email_field">
    <input type="email" name="${SHA1_EMAIL_CONFIRM}" autocomplete="${opts.emailAutocomplete}" id="email_confirm">
    <input type="text" name="${SHA1_TIMEZONE}" value="${opts.timezoneValue}" id="timezone_field">
  </form>
  </body></html>`;
}

describe("parseBhwRegistrationForm", () => {
  test("extracts token, reg key, and sitekey", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml());
    expect(form.xfToken).toBe("1700000000,abc123def456");
    expect(form.regKey).toBe("reg_abc123xyz");
    expect(form.turnstileSitekey).toBe("0x4AAAAAAA-kCmQPJ4mPfcHl");
  });

  test("identifies obfuscated username and email by autocomplete", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml());
    expect(form.usernameField).toBe(SHA1_USERNAME);
    expect(form.emailField).toBe(SHA1_EMAIL);
  });

  test("identifies email confirm as second email match", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml());
    expect(form.emailConfirmField).toBe(SHA1_EMAIL_CONFIRM);
  });

  test("extracts timezone field and value", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml());
    expect(form.timezoneField).toBe(SHA1_TIMEZONE);
    expect(form.timezoneValue).toBe("America/New_York");
  });

  test("falls back to default sitekey when absent", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml({ sitekey: "" }));
    // empty data-sitekey → attr returns "" which is falsy → falls through to default
    const html = registrationFormHtml({ sitekey: "" }).replace(
      /data-sitekey=""/,
      "",
    );
    const form2 = parseBhwRegistrationForm(html);
    expect(form2.turnstileSitekey).toBe(BHW_TURNSTILE_SITEKEY);
  });

  test("reg_key defaults to empty string when absent", () => {
    const form = parseBhwRegistrationForm(
      registrationFormHtml({ includeRegKey: false }),
    );
    expect(form.regKey).toBe("");
  });

  test("extracts turnstile data-action when present", () => {
    const html = registrationFormHtml().replace(
      '<div class="cf-turnstile"',
      '<div class="cf-turnstile" data-action="xf_register"',
    );
    const form = parseBhwRegistrationForm(html);
    expect(form.turnstileAction).toBe("xf_register");
  });

  test("omits turnstileAction when the widget has no data-action", () => {
    const form = parseBhwRegistrationForm(registrationFormHtml());
    expect(form.turnstileAction).toBeUndefined();
  });

  test("throws when username field cannot be identified", () => {
    const html = `
      <html><body>
      <input type="hidden" name="_xfToken" value="1700000000,abc123def456">
      <input type="text" name="plain_name" autocomplete="off">
      </body></html>
    `;
    expect(() => parseBhwRegistrationForm(html)).toThrow(BhwRegistrationError);
  });
});
