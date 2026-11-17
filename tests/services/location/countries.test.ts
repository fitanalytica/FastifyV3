import { describe, test, expect } from 'vitest';
import { countries, countryName, isCountryCode } from '../../../src/services/location/countries.js';

describe('the country list', () => {
  test('250 entries: the ISO codes and Kosovo, each a two-letter upper-case code with a name', () => {
    const entries = Object.entries(countries);
    expect(entries).toHaveLength(250);
    for (const [code, name] of entries) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(typeof name).toBe('string');
      expect(name.trim().length).toBeGreaterThan(1);
    }
  });
  test('the places the real accounts are in, and the names with accents or quotes, are right', () => {
    expect(countries.DK).toBe('Denmark');
    expect(countries.IN).toBe('India');
    expect(countries.XK).toBe('Kosovo');
    expect(countries.CI).toBe("Côte d'Ivoire");
    expect(countries.AX).toBe('Åland Islands');
    expect(countries.RE).toBe('Réunion');
    expect(countries.US).toBe('United States');
    expect(countries.GB).toBe('United Kingdom');
  });
});

describe('countryName', () => {
  test('by code, in any case, with spaces around it', () => {
    expect(countryName('DK')).toBe('Denmark');
    expect(countryName('dk')).toBe('Denmark');
    expect(countryName(' In ')).toBe('India');
  });
  test('no code, an empty one, or one that is not in the list: null', () => {
    for (const none of [null, undefined, '', '  ', 'XX', 'ZZ', 'D', 'DKK', '12']) expect(countryName(none as string | null | undefined)).toBeNull();
  });
  test('a name of an object property is not a country', () => {
    for (const odd of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(countryName(odd)).toBeNull();
      expect(isCountryCode(odd)).toBe(false);
      expect(isCountryCode(odd.toUpperCase())).toBe(false);
    }
  });
  test('isCountryCode wants the upper-case code', () => {
    expect(isCountryCode('DK')).toBe(true);
    expect(isCountryCode('dk')).toBe(false);
    expect(isCountryCode('XX')).toBe(false);
  });
});
