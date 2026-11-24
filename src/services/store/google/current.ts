import { playNotifyAuth } from './auth.js';
import { playClient } from './client.js';
import type { PlayClient, PlayNotifyAuth } from './types.js';

let client: PlayClient = playClient;
let notifyAuth: PlayNotifyAuth = playNotifyAuth;

/** The Play client in use. */
export const currentPlay = (): PlayClient => client;
export const currentPlayNotifyAuth = (): PlayNotifyAuth => notifyAuth;

/** A test replaces Google (nothing can be asked of the real Play here); call with no argument to put the real one back. */
export function setPlayClient(c?: PlayClient): void {
  client = c ?? playClient;
}
export function setPlayNotifyAuth(a?: PlayNotifyAuth): void {
  notifyAuth = a ?? playNotifyAuth;
}
