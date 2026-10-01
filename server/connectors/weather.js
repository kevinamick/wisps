// Weather connector: current conditions and forecasts from Open-Meteo (free, no API key).
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { netFetch } from './net.js';

const CODES = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail' };

export const risk = () => 'read';

async function geocode(place) {
  // Open-Meteo matches plain city names best: try the full text, the part before a comma, and the name
  // without a trailing state code ("Portland OR" → "Portland").
  const first = place.split(',')[0].trim();
  for (const name of [...new Set([place, first, first.replace(/\s+[A-Za-z]{2}\.?$/, '').replace(/\s+D\.?C\.?$/i, '')])]) {
    const r = await (await netFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name.trim())}`)).json();
    if (r.results?.[0]) return r.results[0];
  }
  throw new Error(`Couldn't find "${place}". Try a city name.`);
}

export function tools(conn) {
  return [
    tool('forecast', `Current weather and daily forecast for a place (default: ${conn.config.home || 'ask your owner for their city'}).`,
      { location: z.string().optional().describe('City, e.g. "Boston" or "Paris, France"'), days: z.number().int().min(1).max(14).optional() },
      async ({ location, days = 3 }) => {
        try {
          const place = location || conn.config.home;
          if (!place) return { content: [{ type: 'text', text: 'No location given and no home location set. Ask your owner where they are.' }], isError: true };
          const geo = await geocode(place);
          const f = conn.config.units !== 'celsius';
          const q = new URLSearchParams({ latitude: geo.latitude, longitude: geo.longitude, timezone: 'auto', forecast_days: String(days),
            current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max',
            temperature_unit: f ? 'fahrenheit' : 'celsius', wind_speed_unit: f ? 'mph' : 'kmh', precipitation_unit: f ? 'inch' : 'mm' });
          const w = await (await netFetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
          const u = f ? '°F' : '°C', c = w.current, d = w.daily;
          const lines = [`${geo.name}${geo.admin1 ? `, ${geo.admin1}` : ''}${geo.country ? `, ${geo.country}` : ''}`,
            `Now: ${Math.round(c.temperature_2m)}${u} (feels ${Math.round(c.apparent_temperature)}${u}), ${CODES[c.weather_code] || 'code ' + c.weather_code}, wind ${Math.round(c.wind_speed_10m)} ${f ? 'mph' : 'km/h'}`];
          d.time.forEach((day, i) => lines.push(`${new Date(day + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: ${CODES[d.weather_code[i]] || ''}, ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}${u}, ${d.precipitation_probability_max[i] ?? 0}% chance of precipitation, UV ${Math.round(d.uv_index_max[i] ?? 0)}, sunrise ${d.sunrise[i].slice(11)} sunset ${d.sunset[i].slice(11)}`));
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
      }),
  ];
}
