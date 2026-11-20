import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ActivitiesUpSchema, DeviceUpSchema, InboxUpSchema, ProfileUpSchema, RestoreUpSchema, StateUpSchema, SyncBodySchema, WalkUpSchema } from '../schemas/index.js';
import type { AuthInfo } from './auth.js';

// The unified sync call (docs/data/sync.md). The envelope is checked by the route; each section is checked here, by the section itself, so that one bad section does not refuse the others.
// (This is the one place in `types` with a little code: the services may not import the schemas, and a section must check its own part.)
export type SyncBody = Static<typeof SyncBodySchema>;
export type WalkUp = Static<typeof WalkUpSchema>;
export type RestoreUp = Static<typeof RestoreUpSchema>;
export const isRestoreUp = (value: unknown): value is RestoreUp => Value.Check(RestoreUpSchema, value);
export type InboxUp = Static<typeof InboxUpSchema>;
export const isInboxUp = (value: unknown): value is InboxUp => Value.Check(InboxUpSchema, value);
export type StateUp = Static<typeof StateUpSchema>;
export const isStateUp = (value: unknown): value is StateUp => Value.Check(StateUpSchema, value);
export type ProfileUp = Static<typeof ProfileUpSchema>;
export const isProfileUp = (value: unknown): value is ProfileUp => Value.Check(ProfileUpSchema, value);
export type DeviceUp = Static<typeof DeviceUpSchema>;
export const isDeviceUp = (value: unknown): value is DeviceUp => Value.Check(DeviceUpSchema, value);
export type ActivitiesUp = Static<typeof ActivitiesUpSchema>;
export const isActivitiesUp = (value: unknown): value is ActivitiesUp => Value.Check(ActivitiesUpSchema, value);
export const isWalkUp = (value: unknown): value is WalkUp => Value.Check(WalkUpSchema, value);

/** A section's answer: `ok`, and when it failed a `code` (an `ErrorCode`, or `UNHANDLED`). A section may add its own detail (the walk section says what became of `history` and `today`). */
export type SectionResult = { ok: boolean; code?: string; [detail: string]: unknown };
/** Who a sync call is for: the user, and the token's device (an activity records which device sent it). */
export type SyncContext = { userid: string; auth: AuthInfo; ip: string | undefined };
export type SyncReply = { results: Record<string, SectionResult>; down: Record<string, unknown>; more: boolean };
