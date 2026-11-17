import { test, expect } from 'vitest';
import { kindOfDevice } from '../../../src/services/auth/deviceKind.js';

test('v3 serves the phone (phone, tablet) and the watch; everything else is refused', () => {
  expect(kindOfDevice('phone')).toBe('phone');
  expect(kindOfDevice('tablet')).toBe('phone');
  expect(kindOfDevice('watch')).toBe('watch');
  for (const other of ['chrome', 'mac', '', 'PHONE', 'watchos', 'constructor', '__proto__', null, undefined]) {
    expect(kindOfDevice(other as string | null | undefined), String(other)).toBeNull();
  }
});
