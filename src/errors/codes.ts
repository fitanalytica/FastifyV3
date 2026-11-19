/** The `code` of an error reply. The app acts on these (docs/data/api.md sections 1 and 9): keep the names, they are the contract. */
export const ErrorCode = {
  /** The access JWT has expired but the token is known: refresh once, then retry. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** No such token, revoked, or an invalid JWT: log out. */
  LOGOUT: 'LOGOUT',
  /** The Authorization header is not `Bearer <token>`: a bug, do not retry. */
  INVALID_TOKEN_FORMAT: 'INVALID_TOKEN_FORMAT',
  /** A phone token on a watch route, or the reverse; or a device type v3 does not serve (chrome, mac). */
  WRONG_DEVICE: 'WRONG_DEVICE',
  /** The request does not match the schema (a missing or wrong field in the body, query or params). */
  BAD_REQUEST: 'BAD_REQUEST',
  /** The whole batch is refused (not a list, empty, or too long). */
  BAD_BATCH: 'BAD_BATCH',
  NOT_FOUND: 'NOT_FOUND',
  /** The activity already has the most photos and videos it may have (docs/data/api.md section 6). */
  MEDIA_LIMIT: 'MEDIA_LIMIT',
  /** The file is not there, or is the wrong size or type (docs/data/api.md section 6). */
  BAD_MEDIA: 'BAD_MEDIA',
  /** The post is not well formed: nothing to show, or a template without its numbers (docs/data/api.md section 12). */
  BAD_POST: 'BAD_POST',
  /** The sign-in credential was not accepted (bad, expired or for another app), or the provider is not set up on the server (docs/data/api.md section 1b). */
  LOGIN_REFUSED: 'LOGIN_REFUSED',
  /** The confirmation code for deleting the account is wrong, expired or used up (docs/data/api.md section 8b). */
  DELETE_CODE_WRONG: 'DELETE_CODE_WRONG',
  /** The e-mail that carries a code could not be sent (not set up, or the service did not answer). */
  EMAIL_UNAVAILABLE: 'EMAIL_UNAVAILABLE',
  /** The account could not be deleted completely (a file store did not answer): nothing is lost, try again. */
  DELETE_FAILED: 'DELETE_FAILED',
  /** Neither weather provider answered, or no key is set (docs/data/api.md section 13). The app tries again later. */
  WEATHER_UNAVAILABLE: 'WEATHER_UNAVAILABLE',
  /** The purchase could not be checked with the store (not signed by the store, or for another app), or it is for a product that is not on the list (docs/data/api.md section 15). */
  PURCHASE_REFUSED: 'PURCHASE_REFUSED',
  /** Purchases are not set up on the server (docs/data/api.md section 15): the phone keeps the purchase and tries again later. */
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  /** Redeeming a code (docs/data/api.md section 15): there is no such code. */
  CODE_INVALID: 'CODE_INVALID',
  /** The code has been redeemed already (by someone else, or by the user: the message says which). */
  CODE_USED: 'CODE_USED',
  /** The user already has an active Pro membership, so a code would give nothing. */
  ALREADY_PRO: 'ALREADY_PRO',
  /** The shared membership has already ended. */
  CODE_EXPIRED: 'CODE_EXPIRED',
  /** An error with no specific code. */
  UNHANDLED: 'UNHANDLED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Answered to the app but not worth a row in apperrors. */
export const NOT_LOGGED: ReadonlySet<ErrorCode> = new Set([ErrorCode.TOKEN_EXPIRED, ErrorCode.LOGOUT, ErrorCode.NOT_FOUND]);
