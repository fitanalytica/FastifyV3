import type { AppleVerifier } from '../types.js';
import { appleVerifier } from './verifier.js';

let current: AppleVerifier = appleVerifier;

/** The checker in use. */
export const currentVerifier = (): AppleVerifier => current;

/** A test replaces the checker (nothing can be signed by Apple's keys here); call with no argument to put the real one back. */
export function setAppleVerifier(v?: AppleVerifier): void {
  current = v ?? appleVerifier;
}
