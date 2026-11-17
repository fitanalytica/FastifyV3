import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';
import { aqiFromPm25, iconFor } from '../../src/services/weather/getWeather.js';

// The conditions at a point (docs/data/api.md section 13). The providers are stubbed: no request leaves the machine, and no key is needed.
let app: TestApp;
let a: Account;
beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  await a.remove();
  await app.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const post = (body: object, token = a.phoneToken) => app.inject({ method: 'POST', url: '/phone/v3/weather', headers: bearer(token), payload: body as object });
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const fail = { ok: false, status: 500, json: async () => ({}) };
const keys = () => {
  vi.stubEnv('WEATHER_API', 'test-a');
  vi.stubEnv('OPEN_WEATHER_API', 'test-b');
};

const weatherApi = {
  location: { localtime: '2026-11-17 07:30' },
  current: { temp_c: 20.4, feelslike_c: 19, humidity: 55, wind_kph: 12.5, uv: 3, condition: { code: 1063, text: 'x' }, air_quality: { pm2_5: 12 } },
};
const openWeather = { current: { temp: 290.4, feels_like: 289.6, humidity: 60, wind_speed: 5, uvi: 2, weather: [{ icon: '04n', description: 'broken clouds' }] } };

test('the first provider answers: kelvin, icon by the local hour, index from pm2.5', async () => {
  keys();
  const fetchMock = vi.fn(async () => json(weatherApi));
  vi.stubGlobal('fetch', fetchMock);
  const res = await post({ lat: 18.52, lon: 73.85 });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ uvi: 3, temp: 294, feels_like: 292, humidity: 55, wind_speed: 12.5, weather_icon: '09d', weather_description: 'Patchy rain possible', aqi: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('the second provider takes over when the first fails; wind is converted to km/h', async () => {
  keys();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('weatherapi.com') ? fail : url.includes('air_pollution') ? json({ list: [{ main: { aqi: 4 } }] }) : json(openWeather))));
  const res = await post({ lat: 1, lon: 2 });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ uvi: 2, temp: 290, feels_like: 290, humidity: 60, wind_speed: 18, weather_icon: '04n', weather_description: 'broken clouds', aqi: 4 });
});

test('both providers fail: 502 WEATHER_UNAVAILABLE', async () => {
  keys();
  vi.stubGlobal('fetch', vi.fn(async () => fail));
  const res = await post({ lat: 1, lon: 2 });
  expect(res.statusCode).toBe(502);
  expect(res.json().code).toBe('WEATHER_UNAVAILABLE');
});

test('no key set: 503', async () => {
  vi.stubEnv('WEATHER_API', '');
  vi.stubEnv('OPEN_WEATHER_API', '');
  const res = await post({ lat: 1, lon: 2 });
  expect(res.statusCode).toBe(503);
  expect(res.json().code).toBe('WEATHER_UNAVAILABLE');
});

test('a point off the map is refused, and no token is not served', async () => {
  expect((await post({ lat: 91, lon: 0 })).statusCode).toBe(400);
  expect((await post({ lat: 0 })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/phone/v3/weather', payload: { lat: 0, lon: 0 } })).statusCode).toBe(400);
});

test('index and icon rules', () => {
  expect([0, 9.9, 10, 24.9, 25, 49, 50, 74, 75, 300].map(aqiFromPm25)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  expect(iconFor(1000, '2026-01-01 05:59')).toBe('01n');
  expect(iconFor(1000, '2026-01-01 06:00')).toBe('01d');
  expect(iconFor(1000, '2026-01-01 18:00')).toBe('01n');
  expect(iconFor(9999, '2026-01-01 12:00')).toBe('01d');
});
