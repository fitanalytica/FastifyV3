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
  /** An error with no specific code. */
  UNHANDLED: 'UNHANDLED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Answered to the app but not worth a row in apperrors. */
export const NOT_LOGGED: ReadonlySet<ErrorCode> = new Set([ErrorCode.TOKEN_EXPIRED, ErrorCode.LOGOUT, ErrorCode.NOT_FOUND]);
