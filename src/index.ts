export {
  type CaptchaChallenge,
  type CaptchaSolveOptions,
  type CaptchaSolution,
  type CaptchaSolver,
  type CloudflareWafAutoChallenge,
  type CloudflareWafAutoSolution,
  type CloudflareWafChallenge,
  type CloudflareWafSolution,
  type TurnstileChallenge,
  type TurnstileSolution,
} from "./captcha.js";
export {
  createBhwSession,
  DEFAULT_BHW_BROWSER_OS,
  DEFAULT_BHW_BROWSER_PROFILE,
  DEFAULT_BHW_ORIGIN,
  normalizeBhwProxy,
  parseCookieString,
  type BhwCookieInput,
  type BhwFetchInit,
  type BhwFetchResponse,
  type BhwFetchTransport,
  type BhwProxy,
  type BhwSession,
  type BhwSessionConfig,
  type BhwSessionOptions,
} from "./session.js";
export {
  BhwWafError,
  clearCloudflareWaf,
  isCloudflareChallenge,
  wafResilientTransport,
  type BhwWafOptions,
} from "./waf.js";
export {
  XfProtocolError,
  extractXfToken,
  parseXfDate,
  parseXfPagination,
  type BhwPagination,
  type XfAjaxParams,
} from "./xf2.js";
export {
  BHW_TURNSTILE_SITEKEY,
  DEFAULT_BHW_USER_AGENT,
  BhwRegistrationError,
  parseBhwRegistrationForm,
  registerBhwAccount,
  validateBhwUsername,
  type BhwRegisterOptions,
  type BhwRegistrationDob,
  type BhwRegistrationForm,
  type BhwRegistrationInput,
  type BhwRegistrationResult,
  type BhwUsernameValidation,
} from "./register.js";
export {
  BhwLoginError,
  loginBhwAccount,
  type BhwLoginInput,
  type BhwLoginOptions,
  type BhwLoginResult,
} from "./login.js";
export {
  BhwThreadError,
  fetchBhwThread,
  parseBhwThreadPage,
  replyToBhwThread,
  saveBhwDraft,
  type BhwDraftInput,
  type BhwFetchThreadOptions,
  type BhwReplyInput,
  type BhwReplyResult,
  type BhwThread,
  type BhwThreadPage,
  type BhwThreadPost,
} from "./thread.js";
export {
  createBhwThread,
  fetchBhwThreadCreationForm,
  parseBhwThreadCreationForm,
  type BhwCreateThreadInput,
  type BhwCreateThreadResult,
  type BhwThreadCreationForm,
} from "./create-thread.js";
export {
  BhwPostError,
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
export {
  BhwWhatsNewError,
  fetchBhwWhatsNew,
  parseBhwWhatsNewPage,
  type BhwFeedItem,
  type BhwWhatsNewOptions,
  type BhwWhatsNewPage,
} from "./whatsnew.js";
export {
  BhwSearchError,
  fetchBhwSearch,
  parseBhwSearchPage,
  type BhwSearchItem,
  type BhwSearchOptions,
  type BhwSearchOrder,
  type BhwSearchPage,
} from "./search.js";
export {
  BhwClient,
  type BhwClientOptions,
} from "./client.js";

/** The installed reversebhw package version. */
export const VERSION = "0.1.0";
