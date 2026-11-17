import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { CONDITION_ICON, CONDITION_TEXT } from './conditions.js';

/** The conditions at a point, in the units the app stores (docs/data/api.md section 13): temperatures in kelvin, wind in km/h. */
export type Weather = {
  uvi: number;
  temp: number;
  feels_like: number;
  humidity: number;
  wind_speed: number;
  weather_icon: string;
  weather_description: string;
  aqi: number;
};

const TIMEOUT_MS = 6000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weather provider answered ${res.status}`);
  return res.json();
}

const kelvin = (celsius: number) => Math.round(celsius + 273.15);

/** PM2.5 (ug/m3) to the 1..5 index the app uses (1 good, 5 very poor). */
export function aqiFromPm25(pm25: number): number {
  if (pm25 < 10) return 1;
  if (pm25 < 25) return 2;
  if (pm25 < 50) return 3;
  if (pm25 < 75) return 4;
  return 5;
}

/** The OpenWeather icon for a WeatherAPI code, `d` by day (06:00 to 17:59 local) and `n` by night. `localtime` is `YYYY-MM-DD HH:mm`. */
export function iconFor(code: number, localtime: string): string {
  const hour = Number(localtime.split(' ')[1]?.split(':')[0]);
  const day = hour >= 6 && hour < 18;
  return `${CONDITION_ICON[code] ?? '01'}${day ? 'd' : 'n'}`;
}

async function fromWeatherApi(key: string, lat: number, lon: number): Promise<Weather> {
  const d = await getJson(`https://api.weatherapi.com/v1/current.json?key=${encodeURIComponent(key)}&q=${lat},${lon}&aqi=yes`);
  const c = d.current;
  const code = Number(c.condition.code);
  return {
    uvi: c.uv,
    temp: kelvin(c.temp_c),
    feels_like: kelvin(c.feelslike_c),
    humidity: c.humidity,
    wind_speed: c.wind_kph,
    weather_icon: iconFor(code, d.location.localtime),
    weather_description: CONDITION_TEXT[code] ?? c.condition.text,
    aqi: typeof c.air_quality?.pm2_5 === 'number' ? aqiFromPm25(c.air_quality.pm2_5) : 3,
  };
}

async function fromOpenWeather(key: string, lat: number, lon: number): Promise<Weather> {
  const k = encodeURIComponent(key);
  const [w, air] = await Promise.all([
    getJson(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&appid=${k}`),
    getJson(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${k}`).catch(() => null),
  ]);
  const c = w.current;
  return {
    uvi: c.uvi,
    temp: Math.round(c.temp),
    feels_like: Math.round(c.feels_like),
    humidity: c.humidity,
    // OpenWeather gives metres per second.
    wind_speed: Math.round(c.wind_speed * 3.6 * 10) / 10,
    weather_icon: c.weather[0].icon,
    weather_description: c.weather[0].description,
    aqi: air?.list?.[0]?.main?.aqi ?? 3,
  };
}

/**
 * The conditions now at a point: WeatherAPI first, OpenWeather when it fails (the order the old API used). 503 when no key is set, 502 when both fail.
 */
export async function getWeather(lat: number, lon: number): Promise<Weather> {
  const { weatherApiKey, openWeatherKey } = env().weather;
  if (!weatherApiKey && !openWeatherKey) throw errors.Unavailable('Weather is not configured', ErrorCode.WEATHER_UNAVAILABLE);
  if (weatherApiKey) {
    try {
      return await fromWeatherApi(weatherApiKey, lat, lon);
    } catch {
      // fall through to the second provider
    }
  }
  if (openWeatherKey) {
    try {
      return await fromOpenWeather(openWeatherKey, lat, lon);
    } catch {
      // both failed
    }
  }
  throw errors.BadGateway('No weather provider answered', ErrorCode.WEATHER_UNAVAILABLE);
}
