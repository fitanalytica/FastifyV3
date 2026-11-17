import type { Static } from '@sinclair/typebox';
import type { DeleteCodeBodySchema, LoginBodySchema, ProfileBodySchema, VisibilityBodySchema, UserFeedQuerySchema, UserIdParamsSchema, WeatherBodySchema, PostContentSchema, PostIdParamsSchema, PostsQuerySchema, PutPostBodySchema } from '../schemas/index.js';
import type { AckBodySchema, ActivityIdParamsSchema, BatchBodySchema, DevLoginBodySchema, FeedQuerySchema, CommitBodySchema, InboxQuerySchema, ProfileCommitBodySchema, ProfileImageParamsSchema, ProfileKindParamsSchema, ProfilePresignBodySchema, LogoutBodySchema, MediaParamsSchema, PresignBodySchema, RefreshBodySchema, RestoreQuerySchema, WearableRestoreQuerySchema, LocationBodySchema } from '../schemas/index.js';

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
export type PresignBody = Static<typeof PresignBodySchema>;
export type CommitBody = Static<typeof CommitBodySchema>;
export type ProfilePresignBody = Static<typeof ProfilePresignBodySchema>;
export type ProfileCommitBody = Static<typeof ProfileCommitBodySchema>;
export type ProfileKindParams = Static<typeof ProfileKindParamsSchema>;
export type ProfileImageParams = Static<typeof ProfileImageParamsSchema>;
export type MediaParams = Static<typeof MediaParamsSchema>;
export type PostIdParams = Static<typeof PostIdParamsSchema>;
export type PostContent = Static<typeof PostContentSchema>;
export type PutPostBody = Static<typeof PutPostBodySchema>;
export type PostsQuery = Static<typeof PostsQuerySchema>;
export type FeedQuery = Static<typeof FeedQuerySchema>;
export type WearableRestoreQuery = Static<typeof WearableRestoreQuerySchema>;

// Replies.
export interface DevLoginResponse {
  accessToken: string;
  refreshToken: string;
  userid: string;
  downloadid: string;
}

export interface LoginResponse extends DevLoginResponse {
  email: string | null;
  /** From the provider, to start the profile's name with (Apple: only on the first sign-in, as the app sent it). */
  givenName: string | null;
  familyName: string | null;
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

export type WeatherBody = Static<typeof WeatherBodySchema>;
export type UserIdParams = Static<typeof UserIdParamsSchema>;
export type UserFeedQuery = Static<typeof UserFeedQuerySchema>;
export type VisibilityBody = Static<typeof VisibilityBodySchema>;
export type ProfileBody = Static<typeof ProfileBodySchema>;
export type LoginBody = Static<typeof LoginBodySchema>;
export type DeleteCodeBody = Static<typeof DeleteCodeBodySchema>;
