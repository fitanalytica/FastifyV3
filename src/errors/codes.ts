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
  /** Neither weather provider answered, or no key is set (docs/data/api.md section 13). The app tries again later. */
  WEATHER_UNAVAILABLE: 'WEATHER_UNAVAILABLE',
  /** An error with no specific code. */
  UNHANDLED: 'UNHANDLED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Answered to the app but not worth a row in apperrors. */
export const NOT_LOGGED: ReadonlySet<ErrorCode> = new Set([ErrorCode.TOKEN_EXPIRED, ErrorCode.LOGOUT, ErrorCode.NOT_FOUND]);
