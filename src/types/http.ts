import type { Static } from '@sinclair/typebox';
import type { AckBodySchema, ActivityIdParamsSchema, BatchBodySchema, DevLoginBodySchema, InboxQuerySchema, LogoutBodySchema, RefreshBodySchema, RestoreQuerySchema, WearableRestoreQuerySchema, LocationBodySchema } from '../schemas/index.js';

// Request bodies, queries and params come from the schemas (src/schemas): one definition for the check and the type.
export type RefreshBody = Static<typeof RefreshBodySchema>;
export type LogoutBody = Static<typeof LogoutBodySchema>;
export type DevLoginBody = Static<typeof DevLoginBodySchema>;
export type BatchBody = Static<typeof BatchBodySchema>;
export type ActivityIdParams = Static<typeof ActivityIdParamsSchema>;
export type InboxQuery = Static<typeof InboxQuerySchema>;
export type AckBody = Static<typeof AckBodySchema>;
export type LocationBody = Static<typeof LocationBodySchema>;
export type RestoreQuery = Static<typeof RestoreQuerySchema>;
export type WearableRestoreQuery = Static<typeof WearableRestoreQuerySchema>;

// Replies.
export interface DevLoginResponse {
  accessToken: string;
  refreshToken: string;
  userid: string;
  downloadid: string;
}

export interface LogoutResponse {
  revoked: number;
}

export interface AckResponse {
  acked: string[];
}

/** The place as saved, with the country's name from the server's list. `state` is null where there is none. */
export interface LocationResponse {
  lat: number;
  lon: number;
  city: string;
  state: string | null;
  iso: string;
  country: string;
}
