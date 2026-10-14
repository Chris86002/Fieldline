import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeFromSky, parseNws, parseNwsWind, parseOpenMeteo, weatherLabel, type OpenMeteoForecast } from "./weather.ts";

// Test fixtures only — shaped like provider responses, not real forecasts.
const FETCHED = Date.UTC(2026, 9, 13, 17, 30); // 10:30 at UTC-7

function openMeteoFixture(): OpenMeteoForecast {
  return {
    utc_offset_seconds: -7 * 3600,
    timezone: "America/Phoenix",
    current: {
      time: "2026-10-13T10:30",
      temperature_2m: 21.5,
      relative_humidity_2m: 30,
      wind_speed_10m: 4,
      wind_direction_10m: 225,
      pressure_msl: 1012,
    },
    hourly: {
      time: ["2026-10-13T09:00", "2026-10-13T10:00", "2026-10-13T11:00", "2026-10-13T12:00"],
      temperature_2m: [19, 21, null, 24],
      wind_speed_10m: [3, 4, 5, null],
      wind_direction_10m: [200, 225, 230, 240],
      wind_gusts_10m: [6, 7, null, 9],
      precipitation_probability: [0, 10, 70, 20],
      weather_code: [1, 2, null, 3],
      pressure_msl: [1010, 1011, 1012, 1012],
    },
    daily: {
      time: ["2026-10-13", "2026-10-14"],
      weather_code: [61, null],
      temperature_2m_max: [26, null],
      temperature_2m_min: [12, 10],
      precipitation_probability_max: [70, null],
      sunrise: ["2026-10-13T06:25", "2026-10-14T06:26"],
      sunset: ["2026-10-13T17:50", "2026-10-14T17:49"],
    },
  };
}

describe("Open-Meteo parsing", () => {
  it("keeps missing current values unknown instead of zero, calm, or clear", () => {
    const weather = parseOpenMeteo(openMeteoFixture(), FETCHED);
    assert.equal(weather.tempC, 21.5);
    assert.equal(weather.apparentC, null, "feels-like must not borrow air temperature");
    assert.equal(weather.cloud, null, "cloud cover must not become 0%");
    assert.equal(weather.code, null, "a missing sky code must not become clear (0)");
    assert.equal(weather.gustMps, null, "missing gusts must not become calm");
    assert.equal(weatherLabel(weather.code), "Sky unknown");
  });

  it("keeps missing hourly and daily values null", () => {
    const weather = parseOpenMeteo(openMeteoFixture(), FETCHED);
    const eleven = weather.hours.find((hour) => hour.time === "2026-10-13T11:00");
    assert.ok(eleven);
    assert.equal(eleven.tempC, null);
    assert.equal(eleven.gustMps, null);
    assert.equal(eleven.code, null);
    assert.equal(weather.days[1].highC, null);
    assert.equal(weather.days[1].popMax, null);
    assert.equal(weather.days[1].code, null);
  });

  it("separates the chance this hour from the day's peak", () => {
    const weather = parseOpenMeteo(openMeteoFixture(), FETCHED);
    assert.equal(weather.popHour, 10, "10:30 falls in the 10:00 hour");
    assert.equal(weather.popDayMax, 70);
    assert.equal(weather.today, "2026-10-13");
  });

  it("converts local hour stamps to UTC instants and lists hours from now", () => {
    const weather = parseOpenMeteo(openMeteoFixture(), FETCHED);
    // The 10:00 hour began more than 20 minutes before 10:30, so the strip starts at 11:00 local.
    assert.equal(weather.hours[0].at, Date.UTC(2026, 9, 13, 18, 0));
    assert.equal(weather.sunriseAt, Date.UTC(2026, 9, 13, 13, 25));
  });

  it("records provider, fetch time, zone, and that now is a model value", () => {
    const { source } = parseOpenMeteo(openMeteoFixture(), FETCHED);
    assert.equal(source.provider, "open-meteo");
    assert.equal(source.fetchedAt, FETCHED);
    assert.equal(source.timeZone, "America/Phoenix");
    assert.equal(source.currentKind, "model-now");
    assert.equal(source.currentValidAt, Date.UTC(2026, 9, 13, 17, 30));
    assert.equal(source.cloudInferred, false);
  });

  it("leaves pressure unknown when the provider omits it", () => {
    const fixture = openMeteoFixture();
    delete fixture.current?.pressure_msl;
    const weather = parseOpenMeteo(fixture, FETCHED);
    assert.equal(weather.pressureHpa, null);
    assert.equal(weather.pressureTrend, null);
  });
});

describe("NWS parsing", () => {
  const hourly = {
    properties: {
      updateTime: "2026-10-13T16:05:00+00:00",
      periods: [
        {
          startTime: "2026-10-13T10:00:00-07:00",
          endTime: "2026-10-13T11:00:00-07:00",
          temperature: 70,
          temperatureUnit: "F",
          windSpeed: "10 to 15 mph",
          windDirection: "SW",
          shortForecast: "Mostly Cloudy",
          probabilityOfPrecipitation: { value: null },
          relativeHumidity: { value: 25 },
        },
        {
          startTime: "2026-10-13T11:00:00-07:00",
          endTime: "2026-10-13T12:00:00-07:00",
          temperature: null,
          windSpeed: "",
          windDirection: "",
          shortForecast: "",
        },
      ],
    },
  };
  const daily = {
    properties: {
      periods: [
        { startTime: "2026-10-13T06:00:00-07:00", isDaytime: true, temperature: 78, temperatureUnit: "F", windSpeed: "5 to 20 mph", shortForecast: "Sunny", probabilityOfPrecipitation: { value: 20 } },
        { startTime: "2026-10-13T18:00:00-07:00", isDaytime: false, temperature: 50, temperatureUnit: "F", probabilityOfPrecipitation: { value: null } },
      ],
    },
  };

  it("does not treat the top of a wind-speed range as gusts", () => {
    const weather = parseNws(daily, hourly, null, FETCHED);
    assert.equal(weather.gustMps, null);
    assert.ok(weather.windMps != null && Math.abs(weather.windMps - 10 / 2.236936) < 1e-9);
    assert.ok(weather.days[0].windMaxMps != null && Math.abs(weather.days[0].windMaxMps - 20 / 2.236936) < 1e-9);
  });

  it("keeps missing NWS values unknown", () => {
    const weather = parseNws(daily, hourly, null, FETCHED);
    assert.equal(weather.popHour, null, "a null precipitation chance must not become 0%");
    assert.equal(weather.apparentC, null);
    assert.equal(weather.pressureHpa, null);
    const next = weather.hours[1];
    assert.equal(next.tempC, null);
    assert.equal(next.windMps, null);
    assert.equal(next.windFrom, null, "a blank direction must not become north");
    assert.equal(next.code, null);
  });

  it("labels inferred cloud cover and keeps the daily peak separate", () => {
    const weather = parseNws(daily, hourly, null, FETCHED);
    assert.equal(weather.source.provider, "nws");
    assert.equal(weather.source.cloudInferred, true);
    assert.equal(weather.source.codeInferred, true);
    assert.equal(weather.source.currentKind, "forecast-hour");
    assert.equal(weather.source.issuedAt, Date.UTC(2026, 9, 13, 16, 5));
    assert.equal(weather.cloud, 88);
    assert.equal(weather.popDayMax, 20);
  });

  it("keeps tonight as today in the evening instead of jumping to tomorrow", () => {
    const evening = Date.UTC(2026, 9, 14, 2, 30); // 7:30 PM on Oct 13 at UTC-7
    const eveningHourly = {
      properties: {
        periods: [
          { startTime: "2026-10-13T19:00:00-07:00", endTime: "2026-10-13T20:00:00-07:00", temperature: 60, temperatureUnit: "F", windSpeed: "5 mph", windDirection: "S", shortForecast: "Clear", probabilityOfPrecipitation: { value: 5 } },
        ],
      },
    };
    const eveningDaily = {
      properties: {
        periods: [
          { startTime: "2026-10-13T18:00:00-07:00", isDaytime: false, temperature: 45, temperatureUnit: "F", shortForecast: "Clear", probabilityOfPrecipitation: { value: 10 } },
          { startTime: "2026-10-14T06:00:00-07:00", isDaytime: true, temperature: 80, temperatureUnit: "F", shortForecast: "Showers", probabilityOfPrecipitation: { value: 90 } },
          { startTime: "2026-10-14T18:00:00-07:00", isDaytime: false, temperature: 50, temperatureUnit: "F", probabilityOfPrecipitation: { value: 40 } },
        ],
      },
    };
    const weather = parseNws(eveningDaily, eveningHourly, null, evening);
    assert.equal(weather.today, "2026-10-13");
    assert.equal(weather.days[0].date, "2026-10-13");
    assert.equal(weather.popDayMax, 10, "tomorrow's 90% must not show as today's peak");
    assert.equal(weather.highC, null, "today's daytime high has passed out of the forecast");
    assert.ok(weather.lowC != null && Math.abs(weather.lowC - (45 - 32) * (5 / 9)) < 1e-9);
    assert.equal(weather.days[1].date, "2026-10-14");
    assert.equal(weather.days[1].popMax, 90);
  });

  it("fails rather than inventing a current hour", () => {
    assert.throws(() => parseNws(daily, { properties: { periods: [] } }, null, FETCHED), /unavailable/);
  });

  it("reads wind text units and blank text", () => {
    assert.deepEqual(parseNwsWind(undefined), { low: null, high: null });
    const kmh = parseNwsWind("18 km/h");
    assert.ok(kmh.low != null && Math.abs(kmh.low - 5) < 1e-9);
    assert.equal(codeFromSky(""), null);
    assert.equal(codeFromSky("Patchy Blowing Dust"), null);
  });
});
