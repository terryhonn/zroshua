import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { HaService } from '../ha/ha.service';
import { formatTempC, haReadingToC } from '../units/temp';
import { localDateKey } from '../units/date';

export interface DayWeather {
  /** Always Celsius after normalization from HA. */
  tempMaxC: number | null;
  precipitationProbability: number | null;
  precipitationMm: number | null;
  condition: string | null;
}

export interface WeatherDecision {
  skip: boolean;
  skipReason: string | null;
  multiplierPct: number; // 100 = no change
  detail: string[];
}

/**
 * Weather triggers + temperature scaling. Forecast comes from the HA weather
 * entity (location follows the HA instance); "yesterday actual" comes from a
 * local temperature sensor whose daily max we track ourselves.
 *
 * All temperatures are normalized to °C for comparisons. Journal/skip reasons
 * are formatted with the user's `tempUnit` preference (°C or °F).
 */
@Injectable()
export class WeatherService {
  private readonly log = new Logger('Weather');
  private forecastCache: { at: number; days: DayWeather[] } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly ha: HaService,
  ) {}

  async pickWeatherEntity(): Promise<string | null> {
    const s = await this.config.getSettings();
    if (s.weatherEntity && this.ha.getState(s.weatherEntity)) return s.weatherEntity;
    const first = this.ha.allStates().find((st) => st.entity_id.startsWith('weather.'));
    return first?.entity_id ?? null;
  }

  async getForecast(): Promise<DayWeather[]> {
    if (this.forecastCache && Date.now() - this.forecastCache.at < 30 * 60 * 1000)
      return this.forecastCache.days;
    const entity = await this.pickWeatherEntity();
    if (!entity) return [];
    const unit = this.ha.temperatureUnit(entity);
    const raw = await this.ha.getForecast(entity);
    const days: DayWeather[] = raw.map((f: any) => ({
      tempMaxC:
        f.temperature === null || f.temperature === undefined || !Number.isFinite(Number(f.temperature))
          ? null
          : haReadingToC(Number(f.temperature), unit),
      precipitationProbability: f.precipitation_probability ?? null,
      precipitationMm: f.precipitation ?? null,
      condition: f.condition ?? null,
    }));
    this.forecastCache = { at: Date.now(), days };
    return days;
  }

  async currentWeather() {
    const entity = await this.pickWeatherEntity();
    const state = entity ? this.ha.getState(entity) : null;
    // Always expose Celsius so the UI can convert with the user's tempUnit.
    const temperatureC = entity ? this.ha.temperatureC(entity) : null;
    return {
      entity,
      condition: state?.state ?? null,
      temperature: temperatureC,
      humidity: state?.attributes?.humidity ?? null,
      windSpeed: state?.attributes?.wind_speed ?? null,
      forecast: await this.getForecast().catch(() => []),
    };
  }

  /** Track daily max of the configured local temperature sensor (for "yesterday was hot"). */
  async trackLocalTemperature() {
    const s = await this.config.getSettings();
    const sensor = s.tempScale.yesterdaySensor;
    if (!sensor) return;
    const value = this.ha.temperatureC(sensor);
    if (value === null) return;
    const key = 'tempTrack';
    const today = localDateKey();
    const track = await this.config.getKV<{ date: string; max: number; prevMax: number | null }>(key, {
      date: today,
      max: value,
      prevMax: null,
    });
    if (track.date !== today) {
      await this.config.setKV(key, { date: today, max: value, prevMax: track.max });
    } else if (value > track.max) {
      await this.config.setKV(key, { ...track, max: value });
    }
  }

  private async yesterdayMax(): Promise<number | null> {
    const track = await this.config.getKV<{ prevMax: number | null }>('tempTrack', { prevMax: null } as any);
    return track.prevMax ?? null;
  }

  /** Evaluate skip/scale decision for a group at schedule time. */
  async evaluate(groupId: string): Promise<WeatherDecision> {
    const s = await this.config.getSettings();
    const unit = s.tempUnit ?? 'C';
    const detail: string[] = [];
    let multiplierPct = 100;

    const forecast = await this.getForecast().catch(() => []);
    const today = forecast[0];

    if (s.weatherTriggers.enabled && today) {
      const prob = today.precipitationProbability ?? 0;
      const amount = today.precipitationMm ?? 0;
      if (prob >= s.weatherTriggers.rainProbPct && amount >= s.weatherTriggers.rainAmountMm) {
        return {
          skip: true,
          skipReason: `rain forecast ${prob}% / ${amount}mm exceeds thresholds`,
          multiplierPct: 0,
          detail,
        };
      }
      if (s.weatherTriggers.freezeC !== null && today.tempMaxC !== null && today.tempMaxC <= s.weatherTriggers.freezeC) {
        return {
          skip: true,
          skipReason: `freeze protect (${formatTempC(today.tempMaxC, unit)})`,
          multiplierPct: 0,
          detail,
        };
      }
    }

    if (s.tempScale.enabled && (s.tempScale.groups.length === 0 || s.tempScale.groups.includes(groupId))) {
      const forecastT = s.tempScale.useForecast ? today?.tempMaxC ?? null : null;
      const sensorT = await this.yesterdayMax();
      let t: number | null = null;
      switch (s.tempScale.combine) {
        case 'forecast_only': t = forecastT; break;
        case 'sensor_only': t = sensorT; break;
        case 'avg':
          t = forecastT !== null && sensorT !== null ? (forecastT + sensorT) / 2 : forecastT ?? sensorT;
          break;
        default:
          t = forecastT !== null && sensorT !== null ? Math.max(forecastT, sensorT) : forecastT ?? sensorT;
      }
      if (t !== null) {
        for (const step of s.tempScale.steps) {
          const hit =
            (step.belowC !== undefined && t < step.belowC) ||
            (step.aboveC !== undefined && t > step.aboveC);
          if (!hit) continue;
          if (step.action === 'skip')
            return {
              skip: true,
              skipReason: `temperature ${formatTempC(t, unit)} below skip threshold`,
              multiplierPct: 0,
              detail,
            };
          if (step.pct) {
            multiplierPct += step.pct;
            detail.push(`temp ${formatTempC(t, unit)} → ${step.pct > 0 ? '+' : ''}${step.pct}%`);
          }
        }
      }
    }

    multiplierPct = Math.max(0, multiplierPct);
    return { skip: false, skipReason: null, multiplierPct, detail };
  }

  /** Upper bound of the temperature boost — used to reserve schedule window space. */
  async maxBoostPct(): Promise<number> {
    const s = await this.config.getSettings();
    if (!s.tempScale.enabled) return 100;
    const boost = s.tempScale.steps.reduce((acc, st) => acc + Math.max(0, st.pct ?? 0), 100);
    return boost;
  }

  /** Forecast entry for a day offset (0 = today); null when out of horizon. */
  async forecastDay(offset: number): Promise<DayWeather | null> {
    const days = await this.getForecast().catch(() => [] as DayWeather[]);
    return days[offset] ?? null;
  }

  /** Lower bound of the temperature scaling — the earliest a scaled run can finish. */
  async minBoostPct(): Promise<number> {
    const s = await this.config.getSettings();
    if (!s.tempScale.enabled) return 100;
    return Math.max(0, s.tempScale.steps.reduce((acc, st) => acc + Math.min(0, st.pct ?? 0), 100));
  }
}
