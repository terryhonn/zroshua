import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../db/database.module';
import { Group, GroupRule, Run, Schedule, WaterSource, Zone } from '../db/entities';
import { ConfigService } from '../config/config.service';
import { HaService } from '../ha/ha.service';
import { JournalService } from '../journal/journal.service';
import { NotifyService } from '../notify/notify.service';
import { WeatherService } from '../weather/weather.service';
import { EventsService } from '../events/events.service';
import { inSeason, occurrences } from './planner';
import { formatTempC } from '../units/temp';
import { formatFlowLpm, formatVolumeL, haFlowToLpm, VolumeUnit } from '../units/volume';
import { localDateKey } from '../units/date';

const TICK_MS = 1000;
/** Wait for HA state after each command (ESPHome / Wi‑Fi valves need more than a few seconds). */
const CHECKBACK_WAIT_MS = 15_000;
const CHECKBACK_RETRIES = 3;
/** Background retries after a stuck-open valve (OFF check-back already failed). */
const STUCK_ESCALATE_MAX = 20;
const STUCK_ESCALATE_INTERVAL_MS = 15_000;
/** Mid-run: how long a confirmed-off valve may stay off before we re-send ON. */
const MIDRUN_OFF_MS = 8_000;
/** Mid-run: ESPHome/Wi-Fi often reboots as unavailable — wait longer before reassert. */
const MIDRUN_UNAVAIL_MS = 20_000;
const MIDRUN_REASSERT_MAX = 3;

interface QueuedRun {
  key: string;
  zoneId: string;
  groupId: string | null;
  groupRunId: string | null;
  seqIndex: number;
  durationMin: number;
  manual: boolean;
  triggeredBy: 'schedule' | 'manual' | 'soil';
  priority: number;
  enqueuedAt: number;
  notBefore: number;
  waitReason?: string;
  /** survive rain-sensor events and skip the wet check (soil triggers in a greenhouse etc.) */
  ignoreRain?: boolean;
}

interface ActiveRun {
  runId: number;
  zoneId: string;
  groupId: string | null;
  sourceId: string | null;
  groupRunId: string | null;
  startTs: number;
  plannedMin: number;
  endsAt: number;
  manual: boolean;
  triggeredBy: string;
  ignoreRain?: boolean;
  energySnapshotKwh: number | null;
  energyIntegralWh: number;
  lastSampleTs: number;
  stopping?: boolean;
  /** first time this run's valve was seen off/unavailable (mid-run hold check) */
  droppedSince?: number;
  reasserting?: boolean;
  reassertCount?: number;
}

interface GroupRunState {
  id: string;
  groupId: string;
  lastEndTs: number;
  remaining: number;
  // group-level notification accumulators
  startNotified?: boolean;
  startTs?: number;
  /** zones enqueued for this run — the queue can't be counted at start time (parallel dispatch drains it first) */
  zonesPlanned?: number;
  zonesDone?: number;
  totalMin?: number;
  liters?: number;
}

interface TailTracker {
  sourceId: string;
  groupId: string;
  until: number;
  startTs: number;
  energySnapshotKwh: number | null;
  energyIntegralWh: number;
  lastSampleTs: number;
}

@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Engine');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  private zonesRepo: Repository<Zone>;
  private groupsRepo: Repository<Group>;
  private rulesRepo: Repository<GroupRule>;
  private sourcesRepo: Repository<WaterSource>;
  private runsRepo: Repository<Run>;

  // config cache
  private zones: Zone[] = [];
  private groups: Group[] = [];
  private rules: GroupRule[] = [];
  private sources: WaterSource[] = [];
  private cacheLoadedAt = 0;

  // runtime state
  queue: QueuedRun[] = [];
  active: ActiveRun[] = [];
  private groupRuns = new Map<string, GroupRunState>();
  private tails: TailTracker[] = [];
  private pumpRefs = new Map<string, number>();
  private pumpStopTimers = new Map<string, NodeJS.Timeout>();
  private firedOccurrences = new Set<string>();
  private faultZones = new Set<string>();
  private lastWetTs = 0;
  private lastWetPersistTs = 0;
  private lastSoilCheck = 0;
  private lastFlowCheck = 0;
  private lastIdleFlowAlert = new Map<string, number>();
  private startingZones = new Set<string>();
  /** queued items whose startRun() is in flight — counted as active by all constraints */
  private pendingStarts: QueuedRun[] = [];
  /** derived never-overlap group pairs from source exclusivity ("a|b", symmetric) */
  private srcMutexPairs = new Set<string>();
  /** Global pause: skip all automatic runs until this ms timestamp. Manual runs ignore it. */
  snoozeUntil = 0;
  paused = false;
  /** Active sequential manual chain (`manual-seq:<ts>`); reused while manual work is outstanding. */
  private currentManualChainId: string | null = null;

  constructor(
    @Inject(DATA_SOURCE) ds: DataSource,
    private readonly config: ConfigService,
    private readonly ha: HaService,
    private readonly journal: JournalService,
    private readonly notify: NotifyService,
    private readonly weather: WeatherService,
    private readonly events: EventsService,
  ) {
    this.zonesRepo = ds.getRepository(Zone);
    this.groupsRepo = ds.getRepository(Group);
    this.rulesRepo = ds.getRepository(GroupRule);
    this.sourcesRepo = ds.getRepository(WaterSource);
    this.runsRepo = ds.getRepository(Run);
  }

  async onModuleInit() {
    await this.reloadConfig();
    this.snoozeUntil = await this.config.getKV('snoozeUntil', 0);
    this.lastWetTs = await this.config.getKV('lastWetTs', 0);
    this.firedOccurrences = new Set(await this.config.getKV<string[]>('firedOccurrences', []));
    this.ha.on('state_changed', (id: string, ns: any, os: any) => this.onStateChanged(id, ns, os));
    this.ha.on('connection', (ok: boolean) => ok && this.resumeAndReconcile().catch((e) => this.log.error(e)));
    this.timer = setInterval(() => void this.safeTick(), TICK_MS);
    this.log.log('Engine started');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reloadConfig() {
    this.zones = await this.zonesRepo.find({ order: { orderIndex: 'ASC' } });
    this.groups = await this.groupsRepo.find({ order: { orderIndex: 'ASC' } });
    this.rules = await this.rulesRepo.find();
    this.sources = await this.sourcesRepo.find();
    this.srcMutexPairs = this.buildSourceMutex();
    this.cacheLoadedAt = Date.now();
  }

  private zone(id: string) { return this.zones.find((z) => z.id === id); }
  private group(id: string | null) { return this.groups.find((g) => g.id === id); }
  private source(id: string | null | undefined) { return this.sources.find((s) => s.id === id); }

  /**
   * Whether automatic watering is allowed for this zone right now.
   * Manual runs never consult this. Unavailable autoAllowEntity never blocks
   * (same "don't leave the garden dry" rule as other sensors).
   */
  autoAllowed(zone: Zone): { ok: boolean; reason?: string } {
    if (zone.autoAllow === false) {
      return { ok: false, reason: 'auto allow switch is off' };
    }
    const entity = zone.autoAllowEntity;
    if (entity && this.ha.available(entity) && !this.ha.isOn(entity)) {
      return { ok: false, reason: `auto disabled by ${entity}` };
    }
    return { ok: true };
  }

  /**
   * Group pairs ("a|b", symmetric) that must never overlap because their water
   * sources are marked exclusive — one source-level rule instead of a mutex per
   * group pair; new groups inherit it automatically.
   */
  private buildSourceMutex(): Set<string> {
    const pairs = new Set<string>();
    const excl = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!excl.has(a)) excl.set(a, new Set());
      excl.get(a)!.add(b);
    };
    for (const s of this.sources) {
      for (const other of s.exclusiveWithSourceIds ?? []) {
        if (other === s.id) continue;
        link(s.id, other);
        link(other, s.id);
      }
    }
    if (!excl.size) return pairs;
    const gs = this.groups.map((g) => ({
      id: g.id,
      sources: new Set(g.zoneIds.map((id) => this.zone(id)?.sourceId).filter(Boolean) as string[]),
    }));
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        let hit = false;
        for (const a of gs[i].sources) {
          const ex = excl.get(a);
          if (!ex) continue;
          for (const b of gs[j].sources) if (ex.has(b)) { hit = true; break; }
          if (hit) break;
        }
        if (hit) {
          pairs.add(`${gs[i].id}|${gs[j].id}`);
          pairs.add(`${gs[j].id}|${gs[i].id}`);
        }
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------- ticking

  private async safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (e: any) {
      this.log.error(`tick failed: ${e.stack ?? e.message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tick() {
    const now = Date.now();
    if (now - this.cacheLoadedAt > 30_000) await this.reloadConfig();

    await this.fireDueOccurrences(now);
    await this.processQueue(now);
    await this.superviseActive(now);
    this.sampleEnergy(now);
    await this.superviseTails(now);
    await this.trackRainWet(now);

    if (now - this.lastSoilCheck > 60_000) {
      this.lastSoilCheck = now;
      try {
        await this.checkSoilTriggers(now);
        await this.checkTempTriggers(now);
        await this.weather.trackLocalTemperature();
      } catch (e: any) {
        this.log.warn(`periodic checks failed: ${e.message}`);
      }
      try {
        await this.maybeSendDigest(now);
      } catch (e: any) {
        this.log.warn(`daily digest failed: ${e.message}`);
      }
    }
    if (now - this.lastFlowCheck > 60_000) {
      this.lastFlowCheck = now;
      await this.checkIdleFlow(now);
      await this.checkFlowDeviation(now);
      await this.preStartAvailabilityCheck(now);
    }
    await this.trackSourceLevels(now);
  }

  // ------------------------------------------------- source volume tracking

  /** last integration timestamp for source level accounting */
  private lastLevelTs = 0;
  private lowLevelAlerted = new Set<string>();

  /**
   * Estimates the water level of finite sources (barrels): capacity minus the
   * calculated consumption of running zones plus a constant refill rate. An
   * analog level sensor (%) overrides the estimate when configured.
   */
  private async trackSourceLevels(now: number) {
    const dtMin = this.lastLevelTs ? (now - this.lastLevelTs) / 60_000 : 0;
    this.lastLevelTs = now;
    for (const src of this.sources) {
      if (!src.capacityL) continue;
      const pctOf = (liters: number) => (liters / src.capacityL!) * 100;
      let level: number;
      const sensorPct = src.levelEntity ? this.ha.numeric(src.levelEntity) : null;
      if (sensorPct !== null && sensorPct !== undefined) {
        level = (sensorPct / 100) * src.capacityL;
      } else {
        level =
          this.sourceLevels.get(src.id) ??
          (await this.config.getKV<number>(`sourceLevelL:${src.id}`, src.capacityL));
        if (dtMin > 0 && dtMin < 10) {
          let outLpm = 0;
          for (const a of this.active) {
            const z = this.zone(a.zoneId);
            if (!z || z.sourceId !== src.id) continue;
            const f = z.flowLpm;
            outLpm += f === null || f === undefined ? 0 : typeof f === 'number' ? f : (f.min + f.max) / 2;
          }
          level = Math.max(0, Math.min(src.capacityL, level - outLpm * dtMin + (src.refillLpm ?? 0) * dtMin));
        }
      }
      // persist at most once a minute to spare the DB
      if (now - (this.levelSavedAt.get(src.id) ?? 0) > 60_000) {
        this.levelSavedAt.set(src.id, now);
        await this.config.setKV(`sourceLevelL:${src.id}`, Math.round(level * 10) / 10);
      }
      this.sourceLevels.set(src.id, level);

      const lowPct = src.lowReservePct ?? 20;
      if (pctOf(level) < lowPct && !this.lowLevelAlerted.has(src.id)) {
        this.lowLevelAlerted.add(src.id);
        await this.journal.add('fault', { code: 'source_low', detail: `${src.name} at ${Math.round(pctOf(level))}% (${Math.round(level)} L)` });
        await this.notify.emit('fault', `🪣 Water source "${src.name}" is low: ~${Math.round(level)} L (${Math.round(pctOf(level))}%).`);
      } else if (pctOf(level) > lowPct + 10) {
        this.lowLevelAlerted.delete(src.id); // re-arm after refill
      }
    }
  }

  private sourceLevels = new Map<string, number>();
  private levelSavedAt = new Map<string, number>();

  /** current estimated level (liters) of a capacity-tracked source */
  sourceLevelL(sourceId: string | null | undefined): number | null {
    if (!sourceId) return null;
    return this.sourceLevels.get(sourceId) ?? null;
  }

  // ------------------------------------------------------- temperature burst

  private async checkTempTriggers(now: number) {
    const settings = await this.config.getSettings();
    const unit = settings.tempUnit ?? 'C';
    for (const t of settings.tempTriggers ?? []) {
      if (!t.enabled) continue;
      // Normalize HA °F sensors to °C so thresholds (always stored in °C) compare correctly.
      const v = this.ha.temperatureC(t.sensor);
      if (v === null || v < t.aboveC) continue;
      const hhmm = new Date(now).toTimeString().slice(0, 5);
      if (t.windowFrom && hhmm < t.windowFrom) continue;
      if (t.windowTo && hhmm > t.windowTo) continue;
      const lastFired = await this.config.getKV<number>(`tempFired:${t.id}`, 0);
      if (now - lastFired < t.cooldownHours * 3600_000) continue;
      if (!t.ignoreRainSensor && (await this.rainIsWet(settings))) continue;
      await this.config.setKV(`tempFired:${t.id}`, now);
      await this.journal.add('info', {
        code: 'temp_trigger',
        detail: `sensor ${t.sensor} at ${formatTempC(v, unit)} ≥ ${formatTempC(t.aboveC, unit)}`,
      });
      if (t.targetKind === 'zone') {
        const zone = this.zone(t.targetId);
        if (zone) {
          this.queue.push({
            key: `temp:${t.id}:${now}`,
            zoneId: zone.id,
            groupId: null,
            groupRunId: null,
            seqIndex: 0,
            durationMin: t.runMin,
            manual: false,
            triggeredBy: 'soil',
            priority: 10,
            enqueuedAt: now,
            notBefore: 0,
            ignoreRain: !!t.ignoreRainSensor,
          });
        }
      } else {
        const group = this.group(t.targetId);
        if (group) await this.startGroupRun(group, 'soil', t.runMin, undefined, { ignoreRain: !!t.ignoreRainSensor });
      }
    }
  }

  // ------------------------------------------------------ flow deviation

  private flowDevSince = new Map<string, number>();
  private flowDevAlertedAt = new Map<string, number>();

  /**
   * Compares the measured source flow with the sum of the flow rates of its
   * running zones; a sustained deviation beyond the threshold means a burst
   * pipe (too high) or clogged emitters / low pressure (too low).
   */
  private async checkFlowDeviation(now: number) {
    for (const src of this.sources) {
      if (!src.flowSensor || !src.flowDeviationPct) continue;
      const running = this.active.filter((a) => this.zone(a.zoneId)?.sourceId === src.id);
      // settle time: skip within 90 s of a start/stop on this source
      const youngest = Math.max(0, ...running.map((a) => a.startTs));
      if (!running.length || now - youngest < 90_000) {
        this.flowDevSince.delete(src.id);
        continue;
      }
      let expected = 0;
      let unknown = false;
      for (const a of running) {
        const z = this.zone(a.zoneId)!;
        const f = z.flowLpm;
        if (f === null || f === undefined) unknown = true;
        else expected += typeof f === 'number' ? f : (f.min + f.max) / 2;
      }
      if (unknown || expected <= 0) continue;
      const actual = this.flowSensorLpm(src.flowSensor);
      if (actual === null) continue;
      const devPct = (Math.abs(actual - expected) / expected) * 100;
      if (devPct < src.flowDeviationPct) {
        this.flowDevSince.delete(src.id);
        continue;
      }
      if (!this.flowDevSince.has(src.id)) this.flowDevSince.set(src.id, now);
      if (now - this.flowDevSince.get(src.id)! < 120_000) continue; // sustained for 2 min
      if (now - (this.flowDevAlertedAt.get(src.id) ?? 0) < 3600_000) continue; // 1 alert/hour
      this.flowDevAlertedAt.set(src.id, now);
      const dir = actual > expected ? 'HIGHER (possible burst pipe)' : 'LOWER (clogged emitters / low pressure?)';
      const volUnit: VolumeUnit = (await this.config.getSettings()).volumeUnit === 'gal' ? 'gal' : 'L';
      await this.journal.add('fault', {
        code: 'flow_deviation',
        detail: `${src.name}: measured ${formatFlowLpm(actual, volUnit)} vs expected ${formatFlowLpm(expected, volUnit)}`,
      });
      await this.notify.emit(
        'fault',
        `💦 Flow on "${src.name}" is ${Math.round(devPct)}% ${dir}: measured ${formatFlowLpm(actual, volUnit)}, expected ${formatFlowLpm(expected, volUnit)} (${running.length} zone(s) running).`,
      );
    }
  }

  // ------------------------------------------------------------ daily digest

  private async maybeSendDigest(now: number) {
    const settings = await this.config.getSettings();
    const digest = settings.notifications.digest;
    if (!digest?.enabled) return;
    const d = new Date(now);
    // <input type="time"> may persist "21:00:00"; toTimeString is always "HH:MM:SS …".
    // Compare HH:MM only — "21:00" < "21:00:00" is true and would skip the whole minute.
    const hhmm = d.toTimeString().slice(0, 5);
    const when = (digest.time ?? '21:00').slice(0, 5);
    if (!when || hhmm < when) return;
    const today = localDateKey(d);
    const last = await this.config.getKV<string>('lastDigestSentOn', '');
    if (last === today) return;
    await this.sendDigest({ now });
  }

  /**
   * Build and send today's digest. A test send uses the same totals but is
   * labelled TEST and does not consume the once-per-day slot.
   */
  async sendDigest(opts: { test?: boolean; now?: number } = {}): Promise<{
    ok: boolean;
    sent: number;
    attempted: number;
    reason?: string;
  }> {
    const now = opts.now ?? Date.now();
    const test = !!opts.test;
    const settings = await this.config.getSettings();
    const today = localDateKey(new Date(now));
    const message = await this.composeDigest(now, settings, today, test);
    const result = await this.notify.emit('digest', message);
    if (result.sent > 0) {
      if (!test) {
        await this.config.setKV('lastDigestSentOn', today);
        await this.journal.add('info', { code: 'daily_digest', detail: message.replace(/\n/g, ' · ') });
        this.log.log(`Daily digest sent to ${result.sent} provider(s)`);
      } else {
        await this.journal.add('info', { code: 'digest_test', detail: `test sent to ${result.sent} provider(s)` });
        this.log.log(`Test digest sent to ${result.sent} provider(s)`);
      }
      return { ok: true, sent: result.sent, attempted: result.attempted };
    }
    const reason =
      result.attempted === 0
        ? 'No notification providers are configured'
        : 'Every provider failed — check add-on logs';
    this.log.warn(`Daily digest${test ? ' (test)' : ''}: ${reason}`);
    return { ok: false, sent: 0, attempted: result.attempted, reason };
  }

  private async composeDigest(
    now: number,
    settings: Awaited<ReturnType<ConfigService['getSettings']>>,
    today: string,
    test: boolean,
  ): Promise<string> {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const rows = await this.runsRepo
      .createQueryBuilder('r')
      .where('r.startTs >= :from AND r.endTs IS NOT NULL', { from: dayStart.getTime() })
      .getMany();
    const runs = rows.filter((r) => r.category !== 'tail');
    const liters = rows.reduce((acc, r) => acc + ((r.litersMin ?? 0) + (r.litersMax ?? 0)) / 2, 0);
    const kwh = rows.reduce((acc, r) => acc + (r.energyKwh ?? 0), 0);
    const minutes = runs.reduce((acc, r) => acc + (r.endTs && r.startTs ? (r.endTs - r.startTs) / 60_000 : 0), 0);
    const skips = await this.journal.countToday('skip');
    const faults = await this.journal.countToday('fault');
    const volUnit: VolumeUnit = settings.volumeUnit === 'gal' ? 'gal' : 'L';
    const cost =
      settings.energyTariffPerKwh != null ? ` (~${(kwh * settings.energyTariffPerKwh).toFixed(2)} ${settings.energyCurrency ?? ''})` : '';
    const body =
      `📊 Zroshua daily digest ${today}\n` +
      `Runs: ${runs.length} · ${Math.round(minutes)} min\n` +
      `Water: ~${formatVolumeL(liters, volUnit)}\n` +
      `Pump energy: ${kwh.toFixed(2)} kWh${cost}\n` +
      `Skips: ${skips} · Faults: ${faults}`;
    return test ? `🧪 TEST digest — not the scheduled send\n${body}` : body;
  }

  /**
   * Alert if a zone's entities (or its source pump) are unavailable shortly
   * before a scheduled start, so there is time to fix the controller.
   */
  private precheckAlerted = new Set<string>();

  private async preStartAvailabilityCheck(now: number) {
    const settings = await this.config.getSettings();
    if (!settings.preStartCheck?.enabled || !this.ha.connected) return;
    const windowMs = Math.max(1, settings.preStartCheck.minutes) * 60_000;

    const checkZone = async (zone: Zone, occKey: string, startTs: number) => {
      const problems: string[] = [];
      for (const e of zone.entities) if (!this.ha.available(e)) problems.push(e);
      const src = this.source(zone.sourceId);
      if (src?.pumpEntity && !this.ha.available(src.pumpEntity)) problems.push(`${src.pumpEntity} (pump)`);
      if (!problems.length) return;
      const key = `${occKey}:${zone.id}`;
      if (this.precheckAlerted.has(key)) return;
      this.precheckAlerted.add(key);
      const when = new Date(startTs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      await this.journal.add('fault', {
        zoneId: zone.id,
        code: 'precheck_unavailable',
        detail: `unavailable before ${when} start: ${problems.join(', ')}`,
      });
      await this.notify.emit(
        'fault',
        `⚠️ Zone "${zone.name}" is scheduled at ${when} but ${problems.join(', ')} is UNAVAILABLE — check the controller.`,
      );
    };

    const boost = (await this.weather.maxBoostPct()) / 100;
    for (const group of this.groups.filter((g) => g.enabled)) {
      for (const occ of occurrences(group, now, now + windowMs, this.shiftFor('group', group, boost))) {
        const schedule = (group.schedules ?? []).find((s) => s.id === occ.scheduleId);
        for (const zone of this.schedZones(group, schedule)) {
          await checkZone(zone, occ.key, occ.ts);
        }
      }
    }
    for (const zone of this.zones.filter((z) => z.enabled && z.schedules?.length)) {
      for (const occ of occurrences(zone, now, now + windowMs, this.shiftFor('zone', zone, boost))) {
        await checkZone(zone, `zone:${occ.key}`, occ.ts);
      }
    }
    if (this.precheckAlerted.size > 1000) {
      this.precheckAlerted = new Set([...this.precheckAlerted].slice(-500));
    }
  }

  // ------------------------------------------------------------- scheduling

  private async fireDueOccurrences(now: number) {
    const boost = (await this.weather.maxBoostPct()) / 100;
    for (const group of this.groups) {
      for (const occ of occurrences(group, now - 5 * 60_000, now + TICK_MS, this.shiftFor('group', group, boost))) {
        if (occ.ts > now || this.firedOccurrences.has(occ.key)) continue;
        this.firedOccurrences.add(occ.key);
        void this.persistFired();
        const schedule = (group.schedules ?? []).find((s) => s.id === occ.scheduleId);
        await this.startGroupRun(group, 'schedule', undefined, schedule);
      }
    }
    // zone-level schedules: water an individual zone more often than its group
    for (const zone of this.zones) {
      if (!zone.schedules?.length) continue;
      for (const occ of occurrences(zone, now - 5 * 60_000, now + TICK_MS, this.shiftFor('zone', zone, boost))) {
        const key = `zone:${occ.key}`;
        if (occ.ts > now || this.firedOccurrences.has(key)) continue;
        this.firedOccurrences.add(key);
        void this.persistFired();
        const schedule = (zone.schedules ?? []).find((sc) => sc.id === occ.scheduleId);
        await this.startZoneScheduled(zone, schedule);
      }
    }
    // prune old dedupe keys once in a while
    if (this.firedOccurrences.size > 2000) {
      this.firedOccurrences = new Set([...this.firedOccurrences].slice(-1000));
      void this.persistFired();
    }
  }

  private persistFired() {
    return this.config.setKV('firedOccurrences', [...this.firedOccurrences]);
  }

  /** A zone's own schedule fired: run just this zone, but under its group's rules. */
  private async startZoneScheduled(zone: Zone, schedule?: import('../db/entities').Schedule) {
    const now = Date.now();
    const containing = this.groups.find((g) => g.zoneIds.includes(zone.id));
    const groupId = containing?.id ?? null;
    if (this.snoozeUntil > now) return this.skip(groupId, zone.id, 'paused', 'all watering is paused');
    if (containing?.snoozeUntil && Number(containing.snoozeUntil) > now)
      return this.skip(groupId, zone.id, 'group_paused', 'group is paused');
    if (zone.snoozeUntil && Number(zone.snoozeUntil) > now)
      return this.skip(groupId, zone.id, 'zone_paused', 'zone is paused');
    if (this.faultZones.has(zone.id))
      return this.skip(groupId, zone.id, 'fault', 'zone is in fault state (stuck open — will not start)');
    const gate = this.autoAllowed(zone);
    if (!gate.ok) return this.skip(groupId, zone.id, 'auto_disabled', gate.reason ?? 'auto allow is off');
    const settings = await this.config.getSettings();
    if ((await this.rainIsWet(settings)) && !zone.ignore?.rain_sensor)
      return this.skip(groupId, zone.id, 'rain_sensor', 'rain sensor is wet (or in dry-out window)');
    if (await this.soilBlocks(zone))
      return this.skip(groupId, zone.id, 'soil_wet', 'soil moisture above block threshold');
    const cond = await this.evaluateConditions(schedule, groupId);
    if (!cond.pass) return this.skip(groupId, zone.id, 'condition', cond.reason ?? 'run condition not met');

    let duration = schedule?.zoneDurations?.[zone.id] ?? zone.baseDurationMin;
    if (!zone.ignore?.weather && groupId) {
      const decision = await this.weather.evaluate(groupId);
      if (decision.skip) return this.skip(groupId, zone.id, 'weather', decision.skipReason ?? 'weather');
      duration = (duration * decision.multiplierPct) / 100;
    }
    duration *= cond.scale; // soil/sensor "water less" conditions (only reduce)
    duration = Math.min(duration, zone.maxRuntimeMin || duration);
    this.queue.push({
      key: `zsched:${zone.id}:${now}`,
      zoneId: zone.id,
      groupId,
      groupRunId: null,
      seqIndex: 0,
      durationMin: duration,
      manual: false,
      triggeredBy: 'schedule',
      priority: containing?.priority ?? 0,
      enqueuedAt: now,
      notBefore: 0,
    });
    this.broadcastState();
  }

  /**
   * Per-schedule run conditions (forecast max temp, rain probability, live
   * sensor value). All must pass; missing data never blocks watering — it is
   * journaled and the condition is treated as passed.
   */
  private async evaluateConditions(
    schedule: import('../db/entities').Schedule | undefined,
    groupId: string | null,
  ): Promise<{ pass: boolean; reason?: string; scale: number }> {
    if (!schedule?.conditions?.length) return { pass: true, scale: 1 };
    const forecast = await this.weather.getForecast().catch(() => []);
    const today = forecast[0];
    let scale = 1;
    for (const c of schedule.conditions) {
      let actual: number | null = null;
      let label = '';
      switch (c.kind) {
        case 'forecast_max':
          actual = today?.tempMaxC ?? null;
          label = 'forecast max temp';
          break;
        case 'forecast_rain_prob':
          actual = today?.precipitationProbability ?? null;
          label = 'forecast rain probability';
          break;
        case 'sensor': {
          const s = this.sensorCondValue(c);
          actual = s.value;
          label = s.label;
          break;
        }
      }
      if (actual === null) {
        await this.journal.add('info', {
          groupId: groupId ?? undefined,
          code: 'condition_no_data',
          detail: `${label} unavailable — condition ignored`,
        });
        continue;
      }
      const ok = c.op === 'gte' ? actual >= c.value : actual <= c.value;
      if (!ok) {
        // action=scale: water for a shorter time instead of skipping (only
        // reduces, so the run always fits inside the reserved worst-case slot)
        if (c.action === 'scale') {
          const pct = Math.max(0, Math.min(100, c.scalePct ?? 50));
          scale *= pct / 100;
          await this.journal.add('adjust', {
            groupId: groupId ?? undefined,
            code: 'condition_scale',
            detail: `${label} ${actual.toFixed(1)} ${c.op === 'gte' ? '<' : '>'} ${c.value} → run at ${pct}%`,
          });
          continue;
        }
        return {
          pass: false,
          reason: `${label} ${actual.toFixed(1)} ${c.op === 'gte' ? '<' : '>'} ${c.value} (condition ${c.op === 'gte' ? '≥' : '≤'} ${c.value})`,
          scale,
        };
      }
    }
    return { pass: true, scale };
  }

  /**
   * Reads a sensor condition's live value: a single `entity`, or several
   * `entities` (e.g. soil-moisture probes covering one zone) combined by
   * `agg` (avg default). Unavailable sensors are dropped; if none report a
   * number the value is null (which callers treat as "ignore the condition").
   */
  private sensorCondValue(c: import('../db/entities').ScheduleCondition): { value: number | null; label: string } {
    const ids = c.entities?.length ? c.entities : c.entity ? [c.entity] : [];
    const vals = ids.map((e) => this.ha.numeric(e)).filter((v): v is number => v !== null && v !== undefined);
    const label = ids.length > 1 ? `${c.agg ?? 'avg'} of ${ids.length} sensors` : `sensor ${ids[0] ?? '?'}`;
    if (!vals.length) return { value: null, label };
    const agg = c.agg ?? 'avg';
    const value = agg === 'min' ? Math.min(...vals) : agg === 'max' ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0) / vals.length;
    return { value, label };
  }

  async startGroupRun(
    group: Group,
    triggeredBy: 'schedule' | 'manual' | 'soil',
    overrideMinutes?: number,
    schedule?: import('../db/entities').Schedule,
    opts?: { ignoreRain?: boolean },
  ) {
    const now = Date.now();
    const manual = triggeredBy === 'manual';
    const ignoreRain = !!opts?.ignoreRain;

    if (!manual) {
      if (this.snoozeUntil > now)
        return this.skip(group.id, null, 'paused', `all watering paused until ${new Date(this.snoozeUntil).toLocaleString()}`);
      if (group.snoozeUntil && Number(group.snoozeUntil) > now)
        return this.skip(group.id, null, 'group_paused', `group paused until ${new Date(Number(group.snoozeUntil)).toLocaleString()}`);
    }

    let condScale = 1;
    if (!manual) {
      const cond = await this.evaluateConditions(schedule, group.id);
      if (!cond.pass) return this.skip(group.id, null, 'condition', cond.reason ?? 'run condition not met');
      condScale = cond.scale;
    }

    let weatherMult = 100;
    if (!manual) {
      const decision = await this.weather.evaluate(group.id);
      if (decision.skip) return this.skip(group.id, null, 'weather', decision.skipReason ?? 'weather');
      weatherMult = decision.multiplierPct;
      if (decision.detail.length)
        await this.journal.add('adjust', { groupId: group.id, code: 'temp_scale', detail: decision.detail.join('; ') });
    }

    const settings = await this.config.getSettings();
    const wet = await this.rainIsWet(settings);
    const groupRunId = `${group.id}:${now}`;
    this.groupRuns.set(groupRunId, { id: groupRunId, groupId: group.id, lastEndTs: 0, remaining: 0 });
    let enqueued = 0;

    const zoneSel = schedule?.zoneSelection?.length ? new Set(schedule.zoneSelection) : null;
    for (let i = 0; i < group.zoneIds.length; i++) {
      const zone = this.zone(group.zoneIds[i]);
      if (!zone || !zone.enabled) continue;
      if (zoneSel && !zoneSel.has(zone.id)) continue; // schedule waters a subset of the group
      if (this.faultZones.has(zone.id)) {
        await this.skip(group.id, zone.id, 'fault', 'zone is in fault state (stuck open — will not start)');
        continue;
      }
      if (!manual && zone.snoozeUntil && Number(zone.snoozeUntil) > now) {
        await this.skip(group.id, zone.id, 'zone_paused', `zone paused until ${new Date(Number(zone.snoozeUntil)).toLocaleString()}`);
        continue;
      }
      if (!manual) {
        const gate = this.autoAllowed(zone);
        if (!gate.ok) {
          await this.skip(group.id, zone.id, 'auto_disabled', gate.reason ?? 'auto allow is off');
          continue;
        }
      }
      if (!manual) {
        const zsrc = this.source(zone.sourceId);
        const lvl = zsrc?.capacityL && zsrc.blockBelowPct != null ? this.sourceLevelL(zsrc.id) : null;
        if (zsrc?.capacityL && zsrc.blockBelowPct != null && lvl !== null && (lvl / zsrc.capacityL) * 100 < zsrc.blockBelowPct) {
          await this.skip(group.id, zone.id, 'source_low', `source "${zsrc.name}" below ${zsrc.blockBelowPct}% (~${Math.round(lvl)} L)`);
          continue;
        }
      }
      if (!manual && !ignoreRain && wet && !zone.ignore?.rain_sensor) {
        await this.skip(group.id, zone.id, 'rain_sensor', 'rain sensor is wet (or in dry-out window)');
        continue;
      }
      if (!manual && (await this.soilBlocks(zone))) {
        await this.skip(group.id, zone.id, 'soil_wet', 'soil moisture above block threshold');
        continue;
      }

      let duration = schedule?.zoneDurations?.[zone.id] ?? overrideMinutes ?? zone.baseDurationMin;
      if (!manual) {
        duration = (duration * group.multiplierPct) / 100;
        if (!zone.ignore?.weather) duration = (duration * weatherMult) / 100;
        duration *= condScale; // soil/sensor "water less" conditions (only reduce)
        const rollover = await this.config.getKV<number>(`rollover:${zone.id}`, 0);
        duration += rollover;
        if (duration < (zone.minDurationMin ?? 0)) {
          await this.config.setKV(`rollover:${zone.id}`, duration);
          await this.skip(group.id, zone.id, 'below_min', `${duration.toFixed(1)}min below minimum, rolled over to next run`);
          continue;
        }
        if (rollover) await this.config.setKV(`rollover:${zone.id}`, 0);
      }
      duration = Math.min(duration, zone.maxRuntimeMin || duration);

      const segments = this.splitCycleSoak(zone, duration);
      for (let segment = 0; segment < segments.length; segment++) {
        this.queue.push({
          key: `${groupRunId}:${zone.id}:${segment}`,
          zoneId: zone.id,
          groupId: group.id,
          groupRunId,
          seqIndex: i * 100 + segment,
          durationMin: segments[segment].minutes,
          manual,
          triggeredBy,
          priority: manual ? 1000 : group.priority,
          enqueuedAt: now,
          notBefore: now + segments[segment].delayMs,
          ignoreRain,
        });
      }
      enqueued++;
    }

    const state = this.groupRuns.get(groupRunId)!;
    state.zonesPlanned = enqueued;
    state.remaining = this.queue.filter((q) => q.groupRunId === groupRunId).length;
    if (!state.remaining) this.groupRuns.delete(groupRunId);
    else this.broadcastState();
    return enqueued;
  }

  private splitCycleSoak(zone: Zone, totalMin: number): { minutes: number; delayMs: number }[] {
    const cs = zone.cycleSoak;
    if (!cs || !cs.max_cycle_min || totalMin <= cs.max_cycle_min) return [{ minutes: totalMin, delayMs: 0 }];
    const segments: { minutes: number; delayMs: number }[] = [];
    let remaining = totalMin;
    let offset = 0;
    while (remaining > 0) {
      const m = Math.min(cs.max_cycle_min, remaining);
      segments.push({ minutes: m, delayMs: offset });
      remaining -= m;
      offset += (m + cs.min_soak_min) * 60_000;
    }
    return segments;
  }

  /** Any valve currently opening or watering (manual or scheduled). */
  private anyZoneRunning(): boolean {
    return this.active.length > 0 || this.pendingStarts.length > 0 || this.startingZones.size > 0;
  }

  private runningZoneWaitReason(): string {
    const names = [
      ...this.active.map((a) => this.zone(a.zoneId)?.name ?? a.zoneId),
      ...this.pendingStarts.map((p) => this.zone(p.zoneId)?.name ?? p.zoneId),
    ];
    const uniq = [...new Set(names)];
    if (uniq.length === 1) return `waiting for "${uniq[0]}" to finish`;
    if (uniq.length > 1) return `waiting for ${uniq.length} running zones to finish`;
    return 'manual queue: waiting for previous zone';
  }

  /**
   * Manual watering with an optional sequential queue.
   * - If nothing is watering → starts immediately.
   * - If any zone is already running (manual *or* scheduled) or a manual
   *   chain is waiting, the zone is appended and starts only after the
   *   current watering finishes (one at a time). Duration defaults to the
   *   zone's configured base duration; override with `minutes` for this run only.
   */
  async startZoneManual(zoneId: string, minutes?: number) {
    const zone = this.zone(zoneId);
    if (!zone) throw new Error('zone not found');
    if (
      this.active.some((a) => a.zoneId === zoneId) ||
      this.startingZones.has(zoneId) ||
      this.pendingStarts.some((p) => p.zoneId === zoneId) ||
      this.queue.some((q) => q.zoneId === zoneId)
    )
      throw new Error('zone is already running or queued');

    const duration = Math.min(minutes ?? zone.baseDurationMin, zone.maxRuntimeMin || 1e9);
    const warnings = this.hydraulicWarnings(zone);
    const now = Date.now();
    const mustWait = this.anyZoneRunning() || this.queue.some((q) => q.manual);

    if (!this.currentManualChainId || !mustWait) {
      this.currentManualChainId = `manual-seq:${now}`;
    }
    const chainId = this.currentManualChainId;
    const seqIndex =
      this.queue.filter((q) => q.groupRunId === chainId).length +
      this.active.filter((a) => a.groupRunId === chainId).length +
      this.pendingStarts.filter((p) => p.groupRunId === chainId).length;

    const item: QueuedRun = {
      key: `manual:${zoneId}:${now}`,
      zoneId,
      groupId: null,
      groupRunId: chainId,
      seqIndex,
      durationMin: duration,
      manual: true,
      triggeredBy: 'manual',
      priority: 1000,
      enqueuedAt: now,
      notBefore: 0,
      waitReason: mustWait ? this.runningZoneWaitReason() : undefined,
    };

    if (!mustWait) {
      // Nothing watering: start immediately (still ignores rain/weather/pause).
      await this.startRun(item);
      return { warnings, queued: false, position: 0, durationMin: duration };
    }

    this.queue.push(item);
    await this.journal.add('info', {
      zoneId,
      code: 'manual_queued',
      detail: `queued for ${duration.toFixed(1)} min (${item.waitReason ?? 'manual queue'})`,
    });
    this.broadcastState();
    return { warnings, queued: true, position: seqIndex, durationMin: duration };
  }

  /** Remove one waiting manual-queue entry by key (does not stop an active run). */
  async removeManualQueueItem(key: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => !(q.manual && q.key === key));
    if (this.queue.length === before) throw new Error('queue item not found');
    if (!this.queue.some((q) => q.manual) && !this.active.some((a) => a.manual) && !this.pendingStarts.some((p) => p.manual)) {
      this.currentManualChainId = null;
    }
    this.broadcastState();
  }

  /** Drop all waiting manual-queue items (active manual run continues until stopped). */
  async clearManualQueue() {
    this.queue = this.queue.filter((q) => !q.manual);
    if (!this.active.some((a) => a.manual) && !this.pendingStarts.some((p) => p.manual)) {
      this.currentManualChainId = null;
    }
    this.broadcastState();
  }

  hydraulicWarnings(zone: Zone): string[] {
    const warnings = new Set<string>();
    const src = this.source(zone.sourceId);
    const zoneGroups = this.groups.filter((g) => g.zoneIds.includes(zone.id)).map((g) => g.id);
    for (const a of this.active) {
      const g1 = this.group(a.groupId);
      for (const rule of this.rules) {
        if (rule.type === 'mutex' && g1 && rule.groups.includes(g1.id)) {
          if (zoneGroups.some((gid) => rule.groups.includes(gid) && gid !== g1.id))
            warnings.add(`mutex with running group "${g1.name}"`);
        }
      }
      // a zone without a source (sourceId null) must never match a null dependsOn
      if (src?.dependsOn && a.sourceId === src.dependsOn)
        warnings.add(
          `source "${src.name}" waits for "${this.source(src.dependsOn)?.name ?? src.dependsOn}" which is currently running`,
        );
    }
    const budget = this.flowBudgetCheck(zone);
    if (!budget.ok) warnings.add(budget.reason!);
    return [...warnings];
  }

  // ------------------------------------------------------------------ queue

  private async processQueue(now: number) {
    if (this.paused) return;
    const settings = await this.config.getSettings();
    const sorted = [...this.queue].sort((a, b) => b.priority - a.priority || a.seqIndex - b.seqIndex || a.enqueuedAt - b.enqueuedAt);
    for (const q of sorted) {
      // Rain can start after the run was queued — a group plans all its zones up
      // front, so the sensor has to be re-read before each zone actually starts.
      if (await this.rainBlocks(q, settings)) {
        this.queue = this.queue.filter((x) => x.key !== q.key);
        await this.skip(q.groupId, q.zoneId, 'rain_sensor', 'rain sensor is wet (or in dry-out window)');
        await this.settleEmptyGroupRuns();
        this.broadcastState();
        continue;
      }
      // Auto-allow can flip OFF after enqueue (e.g. overnight rain automation) — skip, don't wait.
      if (!q.manual) {
        const z = this.zone(q.zoneId);
        if (z) {
          const gate = this.autoAllowed(z);
          if (!gate.ok) {
            this.queue = this.queue.filter((x) => x.key !== q.key);
            await this.skip(q.groupId, q.zoneId, 'auto_disabled', gate.reason ?? 'auto allow is off');
            await this.settleEmptyGroupRuns();
            this.broadcastState();
            continue;
          }
        }
      }
      const check = this.canStart(q, now);
      q.waitReason = check.ok ? undefined : check.reason;
      if (!check.ok) {
        // strict mode: a scheduled run blocked by group rules does not wait — it is skipped
        if (
          settings.conflictPolicy === 'skip' &&
          !q.manual &&
          q.waitReason &&
          /^(mutex with|waiting for group)/.test(q.waitReason) &&
          now - q.enqueuedAt > 60_000
        ) {
          this.queue = this.queue.filter((x) => x.key !== q.key);
          await this.skip(q.groupId, q.zoneId, 'conflict_skip', `could not start on time (${q.waitReason}); conflict policy is "skip"`);
          this.broadcastState();
        }
        continue;
      }
      this.queue = this.queue.filter((x) => x.key !== q.key);
      this.pendingStarts.push(q);
      void this.startRun(q).finally(() => {
        this.pendingStarts = this.pendingStarts.filter((p) => p.key !== q.key);
      });
    }
  }

  private canStart(q: QueuedRun, now: number): { ok: boolean; reason?: string } {
    if (q.notBefore > now) return { ok: false, reason: 'waiting for delay/soak' };
    const zone = this.zone(q.zoneId);
    if (!zone) return { ok: false, reason: 'zone missing' };
    if (this.startingZones.has(zone.id) || this.active.some((a) => a.zoneId === zone.id))
      return { ok: false, reason: 'zone already running' };
    if (!zone.entities.every((e) => this.ha.available(e))) return { ok: false, reason: 'entity unavailable' };

    // Sequential manual chain: never overlap another watering, whether that
    // zone was started by a schedule or by a previous manual/queue entry.
    if (q.manual && q.groupRunId?.startsWith('manual-seq:')) {
      if (this.anyZoneRunning()) return { ok: false, reason: this.runningZoneWaitReason() };
    }

    const groupRun = q.groupRunId ? this.groupRuns.get(q.groupRunId) : null;
    const group = this.group(q.groupId);
    if (group && groupRun) {
      const activeInRun =
        this.active.filter((a) => a.groupRunId === q.groupRunId).length +
        this.pendingStarts.filter((p) => p.groupRunId === q.groupRunId).length;
      if (group.mode === 'sequential' && activeInRun > 0) return { ok: false, reason: 'sequential group busy' };
      if (group.mode === 'parallel_limit' && activeInRun >= group.parallelLimit)
        return { ok: false, reason: 'group parallel limit reached' };
      if (group.interZoneDelayS > 0 && groupRun.lastEndTs && now < groupRun.lastEndTs + group.interZoneDelayS * 1000)
        return { ok: false, reason: 'inter-zone delay' };
    }

    if (!q.manual) {
      const gate = this.autoAllowed(zone);
      if (!gate.ok) return { ok: false, reason: gate.reason };
      // mutex rules (active + starting)
      for (const rule of this.rules.filter((r) => r.type === 'mutex')) {
        if (!q.groupId || !rule.groups.includes(q.groupId)) continue;
        const pool = [...this.active, ...this.pendingStarts];
        const conflict = pool.find((a) => a.groupId && a.groupId !== q.groupId && rule.groups.includes(a.groupId));
        if (conflict) return { ok: false, reason: `mutex with group ${this.group(conflict.groupId)?.name ?? conflict.groupId}` };
      }
      // derived source exclusivity (acts like a mutex between the groups)
      if (q.groupId && this.srcMutexPairs.size) {
        const pool = [...this.active, ...this.pendingStarts];
        const conflict = pool.find((a) => a.groupId && a.groupId !== q.groupId && this.srcMutexPairs.has(`${q.groupId}|${a.groupId}`));
        if (conflict)
          return { ok: false, reason: `water sources exclusive with group ${this.group(conflict.groupId)?.name ?? conflict.groupId}` };
      }
      // order rules: "before" group must have no active or queued work
      for (const rule of this.rules.filter((r) => r.type === 'order')) {
        if (rule.after !== q.groupId || !rule.before) continue;
        const busy =
          this.active.some((a) => a.groupId === rule.before) ||
          this.queue.some((x) => x.groupId === rule.before && !x.manual);
        if (busy) return { ok: false, reason: `waiting for group ${this.group(rule.before)?.name ?? rule.before}` };
      }
      // source dependency (active + starting)
      const src = this.source(zone.sourceId);
      const pendingSources = this.pendingStarts.map((p) => this.zone(p.zoneId)?.sourceId).filter(Boolean);
      if (src?.dependsOn && (this.active.some((a) => a.sourceId === src.dependsOn) || pendingSources.includes(src.dependsOn)))
        return { ok: false, reason: `source depends on ${this.source(src.dependsOn)?.name ?? src.dependsOn}` };
      if (src?.okSensor && this.ha.available(src.okSensor) && !this.ha.isOn(src.okSensor))
        return { ok: false, reason: `water source "${src.name}" reports no water` };
      // flow budget
      const budget = this.flowBudgetCheck(zone);
      if (!budget.ok) return { ok: false, reason: budget.reason };
    }
    return { ok: true };
  }

  private flowOf(zone: Zone, pessimistic = true): number | null {
    const f = zone.flowLpm;
    if (f === null || f === undefined) return null;
    if (typeof f === 'number') return f;
    return pessimistic ? f.max : f.min;
  }

  private flowBudgetCheck(candidate: Zone): { ok: boolean; reason?: string } {
    const checkPool = (limit: number | null | undefined, pool: Zone[], label: string) => {
      if (!limit) return null;
      let sum = 0;
      for (const z of pool) {
        const f = this.flowOf(z);
        if (f === null) return `${label}: zone "${z.name}" without flow rate is running (treated as exclusive)`;
        sum += f;
      }
      const cf = this.flowOf(candidate);
      if (cf === null && pool.length > 0) return `${label}: flow rate unknown, waiting for exclusive access`;
      if (sum + (cf ?? 0) > limit) return `${label}: flow budget exceeded (${sum + (cf ?? 0)} > ${limit} l/min)`;
      return null;
    };

    const src = this.source(candidate.sourceId);
    if (src?.maxFlowLpm) {
      const pool = [
        ...this.active.map((a) => this.zone(a.zoneId)!),
        ...this.pendingStarts.map((p) => this.zone(p.zoneId)!),
      ].filter((z) => z && z.sourceId === src.id && z.id !== candidate.id);
      const err = checkPool(src.maxFlowLpm, pool, `source ${src.name}`);
      if (err) return { ok: false, reason: err };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------- run control

  private async startRun(q: QueuedRun) {
    const zone = this.zone(q.zoneId);
    if (!zone) return;
    // last gate before the valve opens: rain may have started while this run was
    // waiting for a pump, a soak delay or the zone ahead of it in the group
    if (await this.rainBlocks(q)) {
      await this.skip(q.groupId, q.zoneId, 'rain_sensor', 'rain sensor is wet (or in dry-out window)');
      await this.settleEmptyGroupRuns();
      this.broadcastState();
      return;
    }
    this.startingZones.add(zone.id);
    try {
      const src = this.source(zone.sourceId);
      if (src?.pumpEntity) await this.acquirePump(src);

      const ok = await this.switchWithCheckback(zone, true);
      if (!ok) {
        // A failed ON is this run only — do not lock the zone out of later
        // schedules (Wi-Fi valves flake). Stuck-OPEN is the safety lockout.
        await this.journal.add('fault', { zoneId: zone.id, code: 'checkback_on', detail: 'zone did not turn on after retries' });
        await this.notify.emit('fault', `⚠️ Zone "${zone.name}" failed to turn ON — skipped, rest of the plan continues.`);
        if (src?.pumpEntity) await this.releasePump(src);
        await this.settleEmptyGroupRuns();
        this.broadcastState();
        return;
      }

      const now = Date.now();
      const row = await this.runsRepo.save({
        zoneId: zone.id,
        groupId: q.groupId,
        sourceId: zone.sourceId,
        startTs: now,
        plannedMin: q.durationMin,
        manual: q.manual,
        category: 'run' as const,
        triggeredBy: q.triggeredBy,
        stopReason: 'completed' as const,
      });

      const energyEntity = src?.energyEntity;
      const snapshot = energyEntity ? this.energyCounterKwh(energyEntity) : null;
      this.active.push({
        runId: row.id,
        zoneId: zone.id,
        groupId: q.groupId,
        sourceId: zone.sourceId,
        groupRunId: q.groupRunId,
        startTs: now,
        plannedMin: q.durationMin,
        endsAt: now + q.durationMin * 60_000,
        manual: q.manual,
        triggeredBy: q.triggeredBy,
        ignoreRain: q.ignoreRain,
        energySnapshotKwh: snapshot,
        energyIntegralWh: 0,
        lastSampleTs: now,
      });
      await this.persistActive();
      await this.journal.add('run_start', {
        zoneId: zone.id,
        groupId: q.groupId ?? undefined,
        detail: `${q.durationMin.toFixed(1)} min (${q.triggeredBy})`,
      });
      // group-level mode: one message per group run, not one per zone
      const groupState = q.groupRunId ? this.groupRuns.get(q.groupRunId) : null;
      const settingsN = (await this.config.getSettings()).notifications;
      if (groupState && settingsN.groupLevel) {
        if (!groupState.startNotified) {
          groupState.startNotified = true;
          groupState.startTs = now;
          const planned =
            groupState.zonesPlanned ??
            new Set(
              [q, ...this.pendingStarts, ...this.queue].filter((x) => x.groupRunId === q.groupRunId).map((x) => x.zoneId),
            ).size;
          const g = this.group(q.groupId);
          await this.notify.emit('run_start', `💧 Group "${g?.name ?? q.groupId}" started: ${planned} zone(s) planned.`);
        }
      } else {
        await this.notify.emit('run_start', `💧 Watering started: "${zone.name}" for ${q.durationMin.toFixed(0)} min.`);
      }
      this.broadcastState();
    } finally {
      this.startingZones.delete(zone.id);
    }
  }

  async stopZone(zoneId: string, reason: Run['stopReason'] = 'manual_stop') {
    const run = this.active.find((a) => a.zoneId === zoneId);
    if (run) await this.finishRun(run, reason);
  }

  /** Stop everything belonging to one group: active runs and queued items. */
  async stopGroup(groupId: string) {
    this.queue = this.queue.filter((q) => q.groupId !== groupId);
    for (const run of [...this.active]) {
      if (run.groupId === groupId) await this.finishRun(run, 'manual_stop');
    }
    this.broadcastState();
  }

  async stopAll(reason: 'manual_stop' | 'rain' = 'manual_stop', predicate?: (a: ActiveRun) => boolean) {
    for (const run of [...this.active]) {
      if (predicate && !predicate(run)) continue;
      await this.finishRun(run, reason);
    }
    if (reason === 'manual_stop') {
      this.queue = [];
      this.groupRuns.clear();
      this.currentManualChainId = null;
      this.broadcastState();
    }
  }

  async extendZone(zoneId: string, minutes: number) {
    const run = this.active.find((a) => a.zoneId === zoneId);
    if (!run) throw new Error('zone is not running');
    run.endsAt = Math.max(Date.now(), run.endsAt + minutes * 60_000);
    await this.persistActive();
    this.broadcastState();
  }

  private async finishRun(run: ActiveRun, reason: Run['stopReason']) {
    if (run.stopping) return;
    run.stopping = true;
    this.active = this.active.filter((a) => a !== run);
    const zone = this.zone(run.zoneId);
    const src = this.source(run.sourceId);

    const off = zone ? await this.switchWithCheckback(zone, false) : true;
    if (!off && zone) {
      this.faultZones.add(zone.id);
      await this.journal.add('fault', { zoneId: zone.id, code: 'stuck_valve', detail: 'zone did not turn OFF — escalating' });
      await this.notify.emit('fault', `🚨 CRITICAL: zone "${zone.name}" did not turn OFF (stuck valve). Shutting down the source pump.`);
      if (src?.pumpEntity) {
        try { await this.ha.turn(src.pumpEntity, false); } catch { /* pump off is best effort here */ }
        this.pumpRefs.set(src.id, 0);
      }
      this.escalateStuck(zone);
    }

    const now = Date.now();
    const actualMin = (now - run.startTs) / 60_000;
    let energyKwh: number | null = null;
    if (src?.energyEntity) {
      const counter = this.energyCounterKwh(src.energyEntity);
      if (run.energySnapshotKwh !== null && counter !== null && counter >= run.energySnapshotKwh)
        energyKwh = counter - run.energySnapshotKwh;
      else if (run.energyIntegralWh > 0) energyKwh = run.energyIntegralWh / 1000;
    }
    const flow = zone?.flowLpm;
    const [lMin, lMax] =
      flow === null || flow === undefined
        ? [null, null]
        : typeof flow === 'number'
          ? [flow * actualMin, flow * actualMin]
          : [flow.min * actualMin, flow.max * actualMin];

    await this.runsRepo.update(run.runId, {
      endTs: now,
      actualMin,
      energyKwh,
      litersMin: lMin,
      litersMax: lMax,
      stopReason: reason,
    });
    await this.persistActive();

    if (src?.pumpEntity && off) await this.releasePump(src);

    let groupFinished: GroupRunState | null = null;
    if (run.groupRunId) {
      const state = this.groupRuns.get(run.groupRunId);
      if (state) {
        state.lastEndTs = now;
        state.remaining -= 1;
        state.zonesDone = (state.zonesDone ?? 0) + 1;
        state.totalMin = (state.totalMin ?? 0) + actualMin;
        state.liters = (state.liters ?? 0) + ((lMin ?? 0) + (lMax ?? 0)) / 2;
        const stillQueued = this.queue.some((x) => x.groupRunId === run.groupRunId);
        if (!stillQueued && !this.active.some((a) => a.groupRunId === run.groupRunId)) {
          this.groupRuns.delete(run.groupRunId);
          groupFinished = state;
          await this.maybeStartTail(run.groupId, src);
        }
      }
    }

    const next = await this.nextRunTs(run.zoneId);
    const nextTxt = next ? ` Next watering: ${new Date(next).toLocaleString()}.` : '';
    await this.journal.add('run_end', {
      zoneId: run.zoneId,
      groupId: run.groupId ?? undefined,
      code: reason,
      detail: `${actualMin.toFixed(1)} min`,
    });
    // Group-level digests only apply to real watering groups (groupId set).
    // Manual runs also carry a groupRunId (`manual-seq:…`) for the sequential
    // queue, but they are never registered in groupRuns — requiring groupId
    // avoids swallowing per-zone run_end for "Water now" / manual chain stops.
    const groupLevel =
      !!run.groupId &&
      !!run.groupRunId &&
      (await this.config.getSettings()).notifications.groupLevel;
    if (reason === 'rain') {
      await this.notify.emit('stop_rain', `🌧 Watering of "${zone?.name ?? run.zoneId}" stopped: rain detected.`);
    } else if (groupLevel) {
      if (groupFinished) {
        const g = this.group(run.groupId);
        const volUnit: VolumeUnit = (await this.config.getSettings()).volumeUnit === 'gal' ? 'gal' : 'L';
        const liters = groupFinished.liters ? ` · ~${formatVolumeL(groupFinished.liters, volUnit)}` : '';
        const wall = groupFinished.startTs ? (now - groupFinished.startTs) / 60_000 : groupFinished.totalMin ?? 0;
        await this.notify.emit(
          'run_end',
          `✅ Group "${g?.name ?? run.groupId}" finished: ${groupFinished.zonesDone} zone(s), ${Math.round(wall)} min${liters}.${nextTxt}`,
        );
      }
    } else {
      await this.notify.emit('run_end', `✅ Watering finished: "${zone?.name ?? run.zoneId}", ${actualMin.toFixed(0)} min.${nextTxt}`);
    }
    // Clear manual chain id when the sequential manual queue is empty
    if (
      run.manual &&
      !this.active.some((a) => a.manual) &&
      !this.pendingStarts.some((p) => p.manual) &&
      !this.queue.some((q) => q.manual)
    ) {
      this.currentManualChainId = null;
    }
    this.broadcastState();
  }

  private escalateStuck(zone: Zone) {
    let attempts = 0;
    const retry = async () => {
      attempts++;
      try {
        for (const e of zone.entities) {
          try {
            await this.ha.turn(e, false);
          } catch (err: any) {
            this.log.warn(`stuck escalate turn_off ${e}: ${err.message}`);
          }
        }
        await new Promise((r) => setTimeout(r, CHECKBACK_WAIT_MS));
        if (!zone.entities.some((e) => this.ha.isOn(e))) {
          this.faultZones.delete(zone.id);
          await this.journal.add('info', {
            zoneId: zone.id,
            code: 'stuck_recovered',
            detail: `recovered after ${attempts} retries — fault cleared`,
          });
          this.broadcastState();
          return;
        }
      } catch {
        /* keep retrying */
      }
      if (attempts < STUCK_ESCALATE_MAX) setTimeout(retry, STUCK_ESCALATE_INTERVAL_MS);
    };
    setTimeout(retry, STUCK_ESCALATE_INTERVAL_MS);
  }

  private async switchWithCheckback(zone: Zone, on: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < CHECKBACK_RETRIES; attempt++) {
      try {
        for (const e of zone.entities) await this.ha.turn(e, on);
      } catch (e: any) {
        this.log.warn(`turn ${on} failed for ${zone.id}: ${e.message}`);
      }
      const deadline = Date.now() + CHECKBACK_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const states = zone.entities.map((e) => this.ha.isOn(e));
        if (on ? states.every(Boolean) : states.every((s) => !s)) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------- pump

  /** pump on/off state observed just before Zroshua first turned it on (for 'restore') */
  private pumpPrevOn = new Map<string, boolean>();

  private async acquirePump(src: WaterSource) {
    const refs = (this.pumpRefs.get(src.id) ?? 0) + 1;
    this.pumpRefs.set(src.id, refs);
    const stopTimer = this.pumpStopTimers.get(src.id);
    if (stopTimer) {
      clearTimeout(stopTimer);
      this.pumpStopTimers.delete(src.id);
    }
    if (refs === 1 && src.pumpEntity) {
      // treat the pump like a controller: warn if it is unavailable at start
      if (!this.ha.available(src.pumpEntity)) {
        await this.journal.add('fault', { code: 'pump_unavailable', detail: `${src.pumpEntity} (${src.name}) is unavailable at start` });
        await this.notify.emit('fault', `⚠️ Pump "${src.pumpEntity}" for source "${src.name}" is UNAVAILABLE — starting anyway; check the controller.`);
      }
      this.pumpPrevOn.set(src.id, this.ha.isOn(src.pumpEntity));
      if (!this.ha.isOn(src.pumpEntity)) {
        await this.ha.turn(src.pumpEntity, true);
        if (src.pumpStartDelayS > 0) await new Promise((r) => setTimeout(r, src.pumpStartDelayS * 1000));
      }
    }
  }

  private async releasePump(src: WaterSource) {
    const refs = Math.max(0, (this.pumpRefs.get(src.id) ?? 1) - 1);
    this.pumpRefs.set(src.id, refs);
    if (refs !== 0 || !src.pumpEntity) return;
    const mode = src.pumpAfterRun ?? 'off';
    // 'keep_on' leaves the pump running; 'restore' only turns it off if it was
    // off before we started (leaves it on if the house was already using it)
    if (mode === 'keep_on') return;
    if (mode === 'restore' && this.pumpPrevOn.get(src.id) === true) return;
    const timer = setTimeout(async () => {
      this.pumpStopTimers.delete(src.id);
      if ((this.pumpRefs.get(src.id) ?? 0) === 0) {
        try { await this.ha.turn(src.pumpEntity!, false); } catch { /* retried next run */ }
      }
    }, Math.max(0, src.pumpStopDelayS) * 1000);
    this.pumpStopTimers.set(src.id, timer);
  }

  // ---------------------------------------------------------------- sensors

  /** Whether the rain sensor must keep this queued run from starting. */
  private async rainBlocks(q: QueuedRun, settings?: Awaited<ReturnType<ConfigService['getSettings']>>): Promise<boolean> {
    if (q.manual || q.ignoreRain) return false;
    if (this.zone(q.zoneId)?.ignore?.rain_sensor) return false;
    return this.rainIsWet(settings);
  }

  /**
   * Drop group runs that have nothing left to run. Normally the last zone's
   * finishRun() closes the run, but when the remaining zones are skipped — by
   * rain, for instance — no run finishes and the state would linger, keeping
   * the source's refill tail from starting.
   */
  private async settleEmptyGroupRuns() {
    for (const [id, state] of [...this.groupRuns]) {
      if (this.queue.some((q) => q.groupRunId === id)) continue;
      if (this.active.some((a) => a.groupRunId === id)) continue;
      if (this.pendingStarts.some((p) => p.groupRunId === id)) continue;
      this.groupRuns.delete(id);
      const zoneId = this.group(state.groupId)?.zoneIds[0];
      await this.maybeStartTail(state.groupId, this.source(zoneId ? this.zone(zoneId)?.sourceId ?? null : null));
    }
  }

  /**
   * The dry-out window runs from the moment the sensor goes dry, so lastWetTs
   * has to mean "last seen wet", not "rain started" — a shower that lasts
   * longer than the window would otherwise leave nothing blocking the run the
   * second it dries. Persisted at most once a minute; the value only has to
   * survive a restart.
   */
  private async trackRainWet(now: number) {
    const s = await this.config.getSettings();
    if (!s.rainSensor.enabled || !s.rainSensor.entities.length) return;
    const wetCount = s.rainSensor.entities.filter((e) => this.ha.isOn(e)).length;
    if (wetCount < Math.max(1, s.rainSensor.quorum)) return;
    this.lastWetTs = now;
    if (now - this.lastWetPersistTs > 60_000) {
      this.lastWetPersistTs = now;
      await this.config.setKV('lastWetTs', this.lastWetTs);
    }
  }

  private async rainIsWet(settings?: Awaited<ReturnType<ConfigService['getSettings']>>): Promise<boolean> {
    const s = settings ?? (await this.config.getSettings());
    if (!s.rainSensor.enabled || !s.rainSensor.entities.length) return false;
    const wetCount = s.rainSensor.entities.filter((e) => this.ha.isOn(e)).length;
    if (wetCount >= Math.max(1, s.rainSensor.quorum)) return true;
    return Date.now() - this.lastWetTs < s.rainSensor.dryOutHours * 3600_000;
  }

  private async onStateChanged(entityId: string, newState: any, oldState: any) {
    const settings = await this.config.getSettings();

    // rain sensor turned wet
    if (settings.rainSensor.enabled && settings.rainSensor.entities.includes(entityId) && newState?.state === 'on') {
      const wetCount = settings.rainSensor.entities.filter((e) => this.ha.isOn(e)).length;
      if (wetCount >= Math.max(1, settings.rainSensor.quorum)) {
        this.lastWetTs = Date.now();
        await this.config.setKV('lastWetTs', this.lastWetTs);
        await this.journal.add('info', { code: 'rain_detected', detail: `sensor ${entityId} is wet` });

        // Drop the queued work first: stopping a run lets the dispatcher start
        // the next zone of the same group, and it would beat a later cleanup.
        const rained = this.queue.filter((q) => !q.manual && !q.ignoreRain && !this.zone(q.zoneId)?.ignore?.rain_sensor);
        this.queue = this.queue.filter((q) => !rained.includes(q));
        for (const q of rained) await this.skip(q.groupId, q.zoneId, 'rain_sensor', 'rain started before this zone ran');

        const linked = settings.rainSensor.linkedZones;
        await this.stopAll('rain', (a) => {
          if (a.manual || a.ignoreRain) return false;
          const z = this.zone(a.zoneId);
          if (!z || z.ignore?.rain_sensor) return false;
          if (settings.rainSensor.onWetDuringRun === 'stop_linked' && linked && !linked.includes(a.zoneId)) return false;
          return true;
        });
        await this.settleEmptyGroupRuns();
        this.broadcastState();
      }
    }

    // zone switched on outside of Zroshua
    const zone = this.zones.find((z) => z.entities.includes(entityId));
    if (
      zone &&
      (newState?.state === 'on' || newState?.state === 'open') &&
      oldState?.state !== newState?.state &&
      !this.active.some((a) => a.zoneId === zone.id) &&
      !this.startingZones.has(zone.id)
    ) {
      if (settings.externalOnPolicy === 'turn_off') {
        await this.journal.add('info', { zoneId: zone.id, code: 'external_on', detail: 'turned on outside Zroshua — turning off' });
        try { await this.ha.turn(entityId, false); } catch { /* logged above */ }
      } else {
        await this.journal.add('info', { zoneId: zone.id, code: 'external_on', detail: 'adopted as manual run with default duration' });
        await this.adoptExternalRun(zone);
      }
    }
  }

  private async adoptExternalRun(zone: Zone) {
    const now = Date.now();
    const row = await this.runsRepo.save({
      zoneId: zone.id,
      groupId: null,
      sourceId: zone.sourceId,
      startTs: now,
      plannedMin: zone.baseDurationMin,
      manual: true,
      category: 'run' as const,
      triggeredBy: 'external',
      stopReason: 'completed' as const,
    });
    this.active.push({
      runId: row.id,
      zoneId: zone.id,
      groupId: null,
      sourceId: zone.sourceId,
      groupRunId: null,
      startTs: now,
      plannedMin: zone.baseDurationMin,
      endsAt: now + zone.baseDurationMin * 60_000,
      manual: true,
      triggeredBy: 'external',
      energySnapshotKwh: null,
      energyIntegralWh: 0,
      lastSampleTs: now,
    });
    await this.persistActive();
    this.broadcastState();
  }

  private async soilBlocks(zone: Zone): Promise<boolean> {
    const settings = await this.config.getSettings();
    for (const t of settings.soilTriggers) {
      if (!t.enabled || t.blockAbovePct === null) continue;
      const applies =
        (t.targetKind === 'zone' && t.targetId === zone.id) ||
        (t.targetKind === 'group' && this.group(t.targetId)?.zoneIds.includes(zone.id));
      if (!applies) continue;
      const v = this.ha.numeric(t.sensor);
      if (v !== null && v > t.blockAbovePct) return true;
    }
    return false;
  }

  private async checkSoilTriggers(now: number) {
    const settings = await this.config.getSettings();
    for (const t of settings.soilTriggers) {
      if (!t.enabled || t.startBelowPct === null) continue;
      const state = this.ha.getState(t.sensor);
      const v = this.ha.numeric(t.sensor);
      if (v === null) continue;
      if (state?.last_changed && now - Date.parse(state.last_changed) > t.staleAfterHours * 3600_000) continue;
      if (v >= t.startBelowPct) continue;
      const lastFired = await this.config.getKV<number>(`soilFired:${t.id}`, 0);
      if (now - lastFired < t.cooldownHours * 3600_000) continue;
      // rain gate: by default a wet rain sensor postpones the trigger (it will
      // fire once dry); triggers marked ignoreRainSensor (greenhouse) fire anyway
      if (!t.ignoreRainSensor && (await this.rainIsWet(settings))) continue;
      await this.config.setKV(`soilFired:${t.id}`, now);
      await this.journal.add('info', { code: 'soil_trigger', detail: `sensor ${t.sensor} at ${v}% < ${t.startBelowPct}%` });
      if (t.targetKind === 'zone') {
        const zone = this.zone(t.targetId);
        if (zone) {
          this.queue.push({
            key: `soil:${t.id}:${now}`,
            zoneId: zone.id,
            groupId: null,
            groupRunId: null,
            seqIndex: 0,
            durationMin: t.runMin,
            manual: false,
            triggeredBy: 'soil',
            priority: 10,
            enqueuedAt: now,
            notBefore: 0,
            ignoreRain: !!t.ignoreRainSensor,
          });
        }
      } else {
        const group = this.group(t.targetId);
        if (group) await this.startGroupRun(group, 'soil', t.runMin, undefined, { ignoreRain: !!t.ignoreRainSensor });
      }
    }
  }

  private async checkIdleFlow(now: number) {
    for (const src of this.sources) {
      if (!src.flowSensor || !src.idleFlowAlertLpm) continue;
      const busy = this.active.some((a) => a.sourceId === src.id);
      if (busy) continue;
      const flow = this.flowSensorLpm(src.flowSensor);
      if (flow !== null && flow > src.idleFlowAlertLpm) {
        const last = this.lastIdleFlowAlert.get(src.id) ?? 0;
        if (now - last < 30 * 60_000) continue;
        this.lastIdleFlowAlert.set(src.id, now);
        const volUnit: VolumeUnit = (await this.config.getSettings()).volumeUnit === 'gal' ? 'gal' : 'L';
        await this.journal.add('fault', {
          code: 'idle_flow',
          detail: `source ${src.name}: ${formatFlowLpm(flow, volUnit)} with no zones running (leak or stuck valve?)`,
        });
        await this.notify.emit(
          'fault',
          `🚨 Source "${src.name}": water is flowing (${formatFlowLpm(flow, volUnit)}) while no zones are running — possible leak or stuck valve.`,
        );
      }
    }
  }

  /** Read a flow sensor and normalize to L/min (HA may report gal/min / GPM). */
  private flowSensorLpm(entityId: string): number | null {
    const st = this.ha.getState(entityId);
    const v = this.ha.numeric(entityId);
    if (v === null) return null;
    return haFlowToLpm(v, st?.attributes?.unit_of_measurement ?? null);
  }

  // ---------------------------------------------------------------- energy

  private energyCounterKwh(entityId: string): number | null {
    const st = this.ha.getState(entityId);
    if (!st) return null;
    const unit = String(st.attributes?.unit_of_measurement ?? '').toLowerCase();
    const v = this.ha.numeric(entityId);
    if (v === null) return null;
    if (unit === 'kwh') return v;
    if (unit === 'wh') return v / 1000;
    return null; // power sensor — handled by integration
  }

  private sampleEnergy(now: number) {
    const sample = (sourceId: string | null, obj: { energyIntegralWh: number; lastSampleTs: number }) => {
      const src = this.source(sourceId);
      if (!src?.energyEntity) return;
      const st = this.ha.getState(src.energyEntity);
      const unit = String(st?.attributes?.unit_of_measurement ?? '').toLowerCase();
      if (unit !== 'w' && unit !== 'kw') return;
      const v = this.ha.numeric(src.energyEntity);
      if (v === null) return;
      const watts = unit === 'kw' ? v * 1000 : v;
      const dtH = (now - obj.lastSampleTs) / 3600_000;
      obj.energyIntegralWh += watts * dtH;
      obj.lastSampleTs = now;
    };
    for (const a of this.active) sample(a.sourceId, a);
    for (const t of this.tails) sample(t.sourceId, t);
  }

  private async maybeStartTail(groupId: string | null, src?: WaterSource) {
    if (!src?.energyTail || !groupId) return;
    const tail = src.energyTail;
    if (tail.afterGroups && tail.afterGroups[groupId] === false) return;
    if (!tail.minutes) return;
    const now = Date.now();
    this.tails.push({
      sourceId: src.id,
      groupId,
      until: now + tail.minutes * 60_000,
      startTs: now,
      energySnapshotKwh: src.energyEntity ? this.energyCounterKwh(src.energyEntity) : null,
      energyIntegralWh: 0,
      lastSampleTs: now,
    });
  }

  private async superviseTails(now: number) {
    for (const tail of [...this.tails]) {
      if (now < tail.until) continue;
      this.tails = this.tails.filter((t) => t !== tail);
      const src = this.source(tail.sourceId);
      let energyKwh: number | null = null;
      if (src?.energyEntity) {
        const counter = this.energyCounterKwh(src.energyEntity);
        if (tail.energySnapshotKwh !== null && counter !== null && counter >= tail.energySnapshotKwh)
          energyKwh = counter - tail.energySnapshotKwh;
        else if (tail.energyIntegralWh > 0) energyKwh = tail.energyIntegralWh / 1000;
      }
      await this.runsRepo.save({
        zoneId: null,
        groupId: tail.groupId,
        sourceId: tail.sourceId,
        startTs: tail.startTs,
        endTs: now,
        plannedMin: (tail.until - tail.startTs) / 60_000,
        actualMin: (now - tail.startTs) / 60_000,
        energyKwh,
        manual: false,
        category: 'tail' as const,
        triggeredBy: 'tail',
        stopReason: 'completed' as const,
      });
    }
  }

  // ------------------------------------------------------------ supervision

  private async superviseActive(now: number) {
    for (const run of [...this.active]) {
      if (run.stopping || run.reasserting) continue;
      const zone = this.zone(run.zoneId);
      if (now >= run.endsAt) {
        await this.finishRun(run, 'completed');
        continue;
      }
      if (zone && (now - run.startTs) / 60_000 > (zone.maxRuntimeMin || 1e9)) {
        await this.journal.add('fault', { zoneId: zone.id, code: 'max_runtime', detail: 'failsafe max runtime exceeded' });
        await this.finishRun(run, 'max_runtime');
        continue;
      }
      if (zone) await this.holdCheck(run, zone, now);
    }
  }

  /** Confirmed on / confirmed off / unavailable-or-mixed. Unavailable is not treated as off. */
  private zoneValveState(zone: Zone): 'on' | 'off' | 'unavailable' {
    const modes = zone.entities.map((e) => {
      const s = this.ha.getState(e)?.state;
      if (s === undefined || s === 'unavailable' || s === 'unknown') return 'unavailable' as const;
      if (s === 'on' || s === 'open') return 'on' as const;
      return 'off' as const;
    });
    if (modes.every((m) => m === 'on')) return 'on';
    if (modes.every((m) => m === 'off')) return 'off';
    return 'unavailable';
  }

  /**
   * If a valve drops off (or stays unavailable) while we still own the run,
   * re-send ON. ESPHome/Wi-Fi valves reboot mid-cycle; without this the
   * dashboard says watering and the sprinklers are dry.
   */
  private async holdCheck(run: ActiveRun, zone: Zone, now: number) {
    const st = this.zoneValveState(zone);
    if (st === 'on') {
      run.droppedSince = undefined;
      return;
    }
    if (!run.droppedSince) run.droppedSince = now;
    const wait = st === 'unavailable' ? MIDRUN_UNAVAIL_MS : MIDRUN_OFF_MS;
    if (now - run.droppedSince < wait) return;

    run.reasserting = true;
    run.reassertCount = (run.reassertCount ?? 0) + 1;
    try {
      await this.journal.add('info', {
        zoneId: zone.id,
        code: 'midrun_reassert',
        detail: `valve ${st} during run — retry ${run.reassertCount}/${MIDRUN_REASSERT_MAX}`,
      });
      const ok = await this.switchWithCheckback(zone, true);
      if (ok) {
        run.droppedSince = undefined;
        this.log.log(`Reasserted "${zone.name}" after mid-run ${st}`);
        return;
      }
      if (run.reassertCount < MIDRUN_REASSERT_MAX) {
        run.droppedSince = Date.now();
        return;
      }
      await this.journal.add('fault', {
        zoneId: zone.id,
        code: 'midrun_lost',
        detail: `valve stayed ${st} after ${MIDRUN_REASSERT_MAX} retries — ending run`,
      });
      await this.notify.emit(
        'fault',
        `⚠️ Zone "${zone.name}" dropped OFF during watering and did not come back — run ended.`,
      );
      await this.finishRun(run, 'fault');
    } finally {
      run.reasserting = false;
    }
  }

  private async persistActive() {
    await this.config.setKV(
      'activeRuns',
      this.active.map((a) => ({ ...a })),
    );
  }

  /**
   * Timestamp of the last time each zone / group actually watered. Skipped
   * runs never create a run row (they only land in the journal), so the runs
   * table already excludes them — a skip is not counted as "last watered".
   * A group's value is the most recent run of any of its zones.
   */
  async lastRuns(): Promise<{ zones: Record<string, number>; groups: Record<string, number> }> {
    const rows = await this.runsRepo
      .createQueryBuilder('r')
      .select('r.zoneId', 'zoneId')
      .addSelect('MAX(r.endTs)', 'ts')
      .where('r.endTs IS NOT NULL AND r.zoneId IS NOT NULL')
      .groupBy('r.zoneId')
      .getRawMany<{ zoneId: string; ts: string | number }>();
    const zones: Record<string, number> = {};
    for (const r of rows) if (r.zoneId && r.ts != null) zones[r.zoneId] = Number(r.ts);

    // A group counts as watered when the group itself ran. Runs started outside
    // a group run — by hand, by a zone schedule or by a soil trigger — carry no
    // groupId, so watering a single zone no longer refreshes the whole group.
    const groupRows = await this.runsRepo
      .createQueryBuilder('r')
      .select('r.groupId', 'groupId')
      .addSelect('MAX(r.endTs)', 'ts')
      .where('r.endTs IS NOT NULL AND r.groupId IS NOT NULL')
      .groupBy('r.groupId')
      .getRawMany<{ groupId: string; ts: string | number }>();
    const groups: Record<string, number> = {};
    for (const r of groupRows) if (r.groupId && r.ts != null) groups[r.groupId] = Number(r.ts);
    return { zones, groups };
  }

  private async resumeAndReconcile() {
    const persisted = await this.config.getKV<ActiveRun[]>('activeRuns', []);
    const now = Date.now();
    for (const p of persisted) {
      if (this.active.some((a) => a.runId === p.runId)) continue;
      const zone = this.zone(p.zoneId);
      if (!zone) continue;
      const stillOn = zone.entities.some((e) => this.ha.isOn(e));
      if (p.endsAt > now) {
        // Time left: turn the valve back on even if HA shows off (add-on /
        // controller restart). Only abandon if check-back fails.
        const ok = stillOn || (await this.switchWithCheckback(zone, true));
        if (ok) {
          this.active.push({
            ...p,
            lastSampleTs: now,
            stopping: false,
            reasserting: false,
            droppedSince: undefined,
          });
          await this.journal.add('info', {
            zoneId: zone.id,
            code: 'resumed',
            detail: `resumed with ${((p.endsAt - now) / 60_000).toFixed(1)} min left`,
          });
          continue;
        }
        await this.journal.add('info', {
          zoneId: zone.id,
          code: 'resume_failed',
          detail: 'could not turn zone back on after restart — run abandoned',
        });
      }
      await this.runsRepo.update(p.runId, { endTs: now, actualMin: (now - p.startTs) / 60_000, stopReason: 'shutdown' });
      if (zone.entities.some((e) => this.ha.isOn(e))) await this.switchWithCheckback(zone, false);
    }
    // reconciliation: anything on without an active run gets turned off
    for (const zone of this.zones) {
      if (this.active.some((a) => a.zoneId === zone.id)) continue;
      if (zone.entities.some((e) => this.ha.isOn(e))) {
        await this.journal.add('info', { zoneId: zone.id, code: 'reconciled', detail: 'zone was on at startup without an active run — turned off' });
        await this.switchWithCheckback(zone, false);
      }
    }
    await this.persistActive();
    this.broadcastState();
  }

  // ------------------------------------------------------------------- misc

  private async skip(groupId: string | null, zoneId: string | null, code: string, detail: string) {
    await this.journal.add('skip', { groupId: groupId ?? undefined, zoneId: zoneId ?? undefined, code, detail });
    await this.notify.emit('skip', `⏭ Watering skipped${zoneId ? ` for zone "${this.zone(zoneId)?.name ?? zoneId}"` : groupId ? ` for group "${this.group(groupId)?.name ?? groupId}"` : ''}: ${detail}`);
    return 0;
  }

  async nextRunTs(zoneId: string): Promise<number | null> {
    const now = Date.now();
    const boost = (await this.weather.maxBoostPct()) / 100;
    let best: number | null = null;
    for (const group of this.groups) {
      if (!group.zoneIds.includes(zoneId)) continue;
      for (const occ of occurrences(group, now, now + 8 * 24 * 3600_000, this.shiftFor('group', group, boost))) {
        const schedule = (group.schedules ?? []).find((s) => s.id === occ.scheduleId);
        if (schedule?.zoneSelection?.length && !schedule.zoneSelection.includes(zoneId)) continue;
        if (best === null || occ.ts < best) best = occ.ts;
      }
    }
    return best;
  }

  /** Wall-clock length of one group run, honoring the execution mode:
   *  sequential = sum, parallel = longest zone, parallel_limit = batches
   *  (same batching as plan()), plus the inter-zone delay between batches. */
  private groupRunMinutes(group: Group, minutes: number[]) {
    if (!minutes.length) return 0;
    const batchSize =
      group.mode === 'parallel' ? minutes.length : group.mode === 'parallel_limit' ? Math.max(1, group.parallelLimit) : 1;
    let total = 0;
    let batches = 0;
    for (let i = 0; i < minutes.length; i += batchSize) {
      total += Math.max(...minutes.slice(i, i + batchSize));
      batches++;
    }
    return total + ((batches - 1) * (group.interZoneDelayS ?? 0)) / 60;
  }

  /** Zones one schedule actually waters: the group's zones filtered by zoneSelection. */
  private schedZones(group: Group, schedule?: Schedule | null): Zone[] {
    const sel = schedule?.zoneSelection?.length ? new Set(schedule.zoneSelection) : null;
    return group.zoneIds
      .filter((id) => !sel || sel.has(id))
      .map((id) => this.zone(id))
      .filter((z): z is Zone => !!z && z.enabled);
  }

  /** Worst-case (max temperature boost) run length of one schedule, in minutes. */
  private worstLenMin(kind: 'group' | 'zone', entity: Group | Zone, scheduleId: string, boostFrac: number): number {
    if (kind === 'zone') {
      const z = entity as Zone;
      const sch = (z.schedules ?? []).find((s) => s.id === scheduleId);
      const d = Math.min(sch?.zoneDurations?.[z.id] ?? z.baseDurationMin, z.maxRuntimeMin || 1e9);
      return Math.min(d * boostFrac, z.maxRuntimeMin || 1e9);
    }
    const g = entity as Group;
    const sch = (g.schedules ?? []).find((s) => s.id === scheduleId);
    const durs = this.schedZones(g, sch).map((z) => {
      const d = Math.min(((sch?.zoneDurations?.[z.id] ?? z.baseDurationMin) * g.multiplierPct) / 100, z.maxRuntimeMin || 1e9);
      return Math.min(d * boostFrac, z.maxRuntimeMin || 1e9);
    });
    return this.groupRunMinutes(g, durs);
  }

  /** occurrences() shift callback for finish-anchored starts. */
  private shiftFor(kind: 'group' | 'zone', entity: Group | Zone, boostFrac: number) {
    return (scheduleId: string) => this.worstLenMin(kind, entity, scheduleId, boostFrac);
  }

  /**
   * Predicts whether an occurrence would be skipped if it fired under the
   * CURRENT conditions (pauses, rain sensor incl. its dry-out window, weather
   * triggers, forecast-based run conditions). `sure` reasons will definitely
   * skip unless the state changes; `maybe` reasons depend on a live sensor.
   */
  private async predictSkip(
    group: Group | null,
    schedule: Schedule | undefined,
    ts: number,
    zones: Zone[],
    settings: Awaited<ReturnType<ConfigService['getSettings']>>,
  ): Promise<{ willSkip: boolean; reasons: string[]; maybe: string[] }> {
    const reasons: string[] = [];
    const maybe: string[] = [];
    const fmt = (t: number) => new Date(t).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

    if (this.snoozeUntil > ts) reasons.push(`all watering paused until ${fmt(this.snoozeUntil)}`);
    if (group?.snoozeUntil && Number(group.snoozeUntil) > ts) reasons.push(`group paused until ${fmt(Number(group.snoozeUntil))}`);
    if (zones.length && zones.every((z) => z.snoozeUntil && Number(z.snoozeUntil) > ts))
      reasons.push('all zones paused');
    if (zones.length) {
      const stuck = zones.filter((z) => this.faultZones.has(z.id));
      if (stuck.length === zones.length) reasons.push('zone is in fault (stuck open)');
      else if (stuck.length) maybe.push(`${stuck.map((z) => z.name).join(', ')} in fault (stuck open)`);
    }

    // sticky auto-allow gate (MQTT switch / optional HA entity) — sure skip if currently off
    if (zones.length) {
      const blocked = zones.filter((z) => !this.autoAllowed(z).ok);
      if (blocked.length === zones.length) {
        const r = this.autoAllowed(blocked[0]).reason ?? 'auto allow is off';
        reasons.push(blocked.length === 1 ? r : `all zones auto-disabled (${r})`);
      } else if (blocked.length) {
        maybe.push(`${blocked.map((z) => z.name).join(', ')} auto-disabled`);
      }
    }

    // rain sensor: currently wet, or inside the dry-out window
    if (settings.rainSensor.enabled && !zones.every((z) => z.ignore?.rain_sensor)) {
      const wetNow = settings.rainSensor.entities.filter((e) => this.ha.isOn(e)).length >= Math.max(1, settings.rainSensor.quorum);
      const dryOutUntil = this.lastWetTs + settings.rainSensor.dryOutHours * 3600_000;
      if (wetNow) maybe.push('rain sensor is wet now');
      else if (dryOutUntil > ts) reasons.push(`rain dry-out until ${fmt(dryOutUntil)}`);
    }

    // weather triggers + forecast conditions for the occurrence's day
    const dayOffset = Math.max(0, Math.floor((ts - new Date().setHours(0, 0, 0, 0)) / (24 * 3600_000)));
    const fc = (await this.weather.forecastDay(dayOffset).catch(() => null)) as any;
    if (fc) {
      const wt = settings.weatherTriggers;
      if (
        wt.enabled &&
        fc.precipitationProbability != null &&
        fc.precipitationMm != null &&
        fc.precipitationProbability >= wt.rainProbPct &&
        fc.precipitationMm >= wt.rainAmountMm
      )
        reasons.push(`rain forecast ${fc.precipitationProbability}% / ${fc.precipitationMm}mm`);
      const unit = settings.tempUnit ?? 'C';
      if (wt.enabled && wt.freezeC != null && fc.tempMaxC != null && fc.tempMaxC <= wt.freezeC)
        reasons.push(`freeze forecast ${formatTempC(fc.tempMaxC, unit)}`);
      const ts_ = settings.tempScale;
      if (ts_.enabled && (!group || ts_.groups.length === 0 || ts_.groups.includes(group.id)) && fc.tempMaxC != null) {
        for (const step of ts_.steps) {
          if (step.action === 'skip' && step.belowC != null && fc.tempMaxC < step.belowC)
            reasons.push(
              `forecast max ${formatTempC(fc.tempMaxC, unit)} below ${formatTempC(step.belowC, unit)} (temp scaling: skip)`,
            );
        }
      }
      for (const c of schedule?.conditions ?? []) {
        if (c.action === 'scale') continue; // scales the duration, never skips
        const actual = c.kind === 'forecast_max' ? fc.tempMaxC : c.kind === 'forecast_rain_prob' ? fc.precipitationProbability : null;
        if (actual != null && !(c.op === 'gte' ? actual >= c.value : actual <= c.value))
          reasons.push(
            `condition: forecast ${
              c.kind === 'forecast_max' ? formatTempC(actual, unit) : `${actual}%`
            } not ${c.op === 'gte' ? '≥' : '≤'} ${c.kind === 'forecast_max' ? formatTempC(c.value, unit) : c.value}`,
          );
      }
    }
    // live-sensor conditions can change by start time — mark as "maybe"
    for (const c of schedule?.conditions ?? []) {
      if (c.kind !== 'sensor' || c.action === 'scale') continue;
      const { value: v, label } = this.sensorCondValue(c);
      if (v != null && !(c.op === 'gte' ? v >= c.value : v <= c.value))
        maybe.push(`${label} now ${v.toFixed(1)} not ${c.op === 'gte' ? '≥' : '≤'} ${c.value}`);
    }
    return { willSkip: reasons.length > 0, reasons, maybe };
  }

  async upcoming(days = 7) {
    const now = Date.now();
    const until = now + days * 24 * 3600_000;
    const out: {
      /** the group this run belongs to (containing group for a zone's own schedule) */
      groupId: string;
      groupName: string;
      /** what to pause to skip this run: a group, or a single zone (own schedule) */
      kind: 'group' | 'zone';
      targetId: string;
      /** current pause end of that target, ms epoch, or null */
      snoozeUntil: number | null;
      ts: number;
      durationMin: number;
      maxDurationMin: number;
      willSkip: boolean;
      skipReasons: string[];
      maybeSkip: string[];
      zones: { zoneId: string; name: string; minutes: number; maxMinutes: number }[];
    }[] = [];
    const settings = await this.config.getSettings();
    const maxBoost = await this.weather.maxBoostPct();

    for (const group of this.groups) {
      for (const occ of occurrences(group, now, until, this.shiftFor('group', group, maxBoost / 100))) {
        const schedule = (group.schedules ?? []).find((s) => s.id === occ.scheduleId);
        const schedZones = this.schedZones(group, schedule);
        const zones = schedZones.map((z) => {
          const minutes = Math.min(
            ((schedule?.zoneDurations?.[z.id] ?? z.baseDurationMin) * group.multiplierPct) / 100,
            z.maxRuntimeMin || 1e9,
          );
          return {
            zoneId: z.id,
            name: z.name,
            minutes,
            maxMinutes: Math.min((minutes * maxBoost) / 100, z.maxRuntimeMin || 1e9),
          };
        });
        const skip = await this.predictSkip(group, schedule, occ.ts, schedZones, settings);
        out.push({
          groupId: group.id,
          groupName: group.name,
          kind: 'group',
          targetId: group.id,
          snoozeUntil: group.snoozeUntil ? Number(group.snoozeUntil) : null,
          ts: occ.ts,
          durationMin: this.groupRunMinutes(group, zones.map((z) => z.minutes)),
          maxDurationMin: this.groupRunMinutes(group, zones.map((z) => z.maxMinutes)),
          willSkip: skip.willSkip,
          skipReasons: skip.reasons,
          maybeSkip: skip.maybe,
          zones,
        });
      }
    }

    // zone-level schedules: a zone watered on its own, more often than its group
    for (const zone of this.zones.filter((z) => z.enabled && z.schedules?.length)) {
      const containing = this.groups.find((g) => g.zoneIds.includes(zone.id));
      for (const occ of occurrences(zone, now, until, this.shiftFor('zone', zone, maxBoost / 100))) {
        const schedule = (zone.schedules ?? []).find((s) => s.id === occ.scheduleId);
        const minutes = Math.min(schedule?.zoneDurations?.[zone.id] ?? zone.baseDurationMin, zone.maxRuntimeMin || 1e9);
        const maxMinutes = Math.min((minutes * maxBoost) / 100, zone.maxRuntimeMin || 1e9);
        const skip = await this.predictSkip(containing ?? null, schedule, occ.ts, [zone], settings);
        out.push({
          groupId: containing?.id ?? zone.id,
          groupName: containing?.name ?? zone.name,
          kind: 'zone',
          targetId: zone.id,
          snoozeUntil: zone.snoozeUntil ? Number(zone.snoozeUntil) : null,
          ts: occ.ts,
          durationMin: minutes,
          maxDurationMin: maxMinutes,
          willSkip: skip.willSkip,
          skipReasons: skip.reasons,
          maybeSkip: skip.maybe,
          zones: [{ zoneId: zone.id, name: zone.name, minutes, maxMinutes }],
        });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Simulated plan for the timeline view. Per-zone segments carry the BASE
   * cascade (start/end without temperature scaling) so zones of one group
   * never visually overlap; scaling is expressed per group occurrence as an
   * envelope [minEnd..end..worstEnd] — temperature scaling shifts every
   * following zone, so only the occurrence's finish window widens.
   * Conflicts are still detected against the worst-case envelope.
   */
  async plan(days = 7) {
    const now = Date.now();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = now + days * 24 * 3600_000;
    const maxBoost = (await this.weather.maxBoostPct()) / 100;
    const minBoost = (await this.weather.minBoostPct()) / 100;

    type Segment = {
      groupId: string | null;
      groupName: string;
      zoneId: string;
      zoneName: string;
      /** occurrence key — groups the segments of one scheduled run */
      occ: string;
      start: number;
      end: number;
      worstEnd: number;
      conflict: boolean;
      kind: 'group' | 'zone';
    };
    /** finish window of one scheduled run: may end anywhere in [minEnd..worstEnd] */
    type Envelope = {
      occ: string;
      groupId: string | null;
      groupName: string;
      start: number;
      minEnd: number;
      end: number;
      worstEnd: number;
      kind: 'group' | 'zone';
    };
    const segments: Segment[] = [];
    const envelopes: Envelope[] = [];

    for (const group of this.groups.filter((g) => g.enabled)) {
      for (const occ of occurrences(group, from.getTime(), to, this.shiftFor('group', group, maxBoost))) {
        const schedule = (group.schedules ?? []).find((s) => s.id === occ.scheduleId);
        const zones = this.schedZones(group, schedule);
        const durOf = (z: Zone) =>
          Math.min(
            ((schedule?.zoneDurations?.[z.id] ?? z.baseDurationMin) * group.multiplierPct) / 100,
            z.maxRuntimeMin || 1e9,
          );
        const occKey = `${group.id}:${occ.ts}`;
        let cursor = occ.ts;
        let worstCursor = occ.ts;
        let minCursor = occ.ts;
        const batchSize = group.mode === 'parallel' ? zones.length : group.mode === 'parallel_limit' ? Math.max(1, group.parallelLimit) : 1;
        for (let i = 0; i < zones.length; i += batchSize) {
          const batch = zones.slice(i, i + batchSize);
          let batchEnd = cursor;
          let worstBatchEnd = worstCursor;
          let minBatchEnd = minCursor;
          for (const z of batch) {
            const d = durOf(z) * 60_000;
            segments.push({
              groupId: group.id,
              groupName: group.name,
              zoneId: z.id,
              zoneName: z.name,
              occ: occKey,
              start: cursor,
              end: cursor + d,
              worstEnd: worstCursor + d * maxBoost,
              conflict: false,
              kind: 'group',
            });
            batchEnd = Math.max(batchEnd, cursor + d);
            worstBatchEnd = Math.max(worstBatchEnd, worstCursor + d * maxBoost);
            minBatchEnd = Math.max(minBatchEnd, minCursor + d * minBoost);
          }
          cursor = batchEnd + group.interZoneDelayS * 1000;
          worstCursor = worstBatchEnd + group.interZoneDelayS * 1000;
          minCursor = minBatchEnd + group.interZoneDelayS * 1000;
        }
        if (zones.length) {
          const delay = group.interZoneDelayS * 1000;
          envelopes.push({
            occ: occKey,
            groupId: group.id,
            groupName: group.name,
            start: occ.ts,
            minEnd: minCursor - delay,
            end: cursor - delay,
            worstEnd: worstCursor - delay,
            kind: 'group',
          });
        }
      }
    }

    for (const zone of this.zones.filter((z) => z.enabled && z.schedules?.length)) {
      const containing = this.groups.find((g) => g.zoneIds.includes(zone.id));
      for (const occ of occurrences(zone, from.getTime(), to, this.shiftFor('zone', zone, maxBoost))) {
        const sch = (zone.schedules ?? []).find((sc) => sc.id === occ.scheduleId);
        const d = Math.min(sch?.zoneDurations?.[zone.id] ?? zone.baseDurationMin, zone.maxRuntimeMin || 1e9) * 60_000;
        const occKey = `zone:${zone.id}:${occ.ts}`;
        segments.push({
          groupId: containing?.id ?? null,
          groupName: containing ? `${containing.name} (zone)` : 'Zone schedule',
          zoneId: zone.id,
          zoneName: zone.name,
          occ: occKey,
          start: occ.ts,
          end: occ.ts + d,
          worstEnd: occ.ts + d * maxBoost,
          conflict: false,
          kind: 'zone',
        });
        envelopes.push({
          occ: occKey,
          groupId: containing?.id ?? null,
          groupName: containing ? `${containing.name} (zone)` : 'Zone schedule',
          start: occ.ts,
          minEnd: occ.ts + d * minBoost,
          end: occ.ts + d,
          worstEnd: occ.ts + d * maxBoost,
          kind: 'zone',
        });
      }
    }

    // mutex/order conflicts: worst-case overlap between rule-bound groups
    // (incl. pairs derived from water-source exclusivity)
    const mutexPairs = new Set<string>(this.srcMutexPairs);
    for (const rule of this.rules) {
      if (rule.type === 'mutex') {
        for (const a of rule.groups) for (const b of rule.groups) if (a !== b) mutexPairs.add(`${a}|${b}`);
      }
      if (rule.type === 'order' && rule.before && rule.after) {
        mutexPairs.add(`${rule.before}|${rule.after}`);
        mutexPairs.add(`${rule.after}|${rule.before}`);
      }
    }
    const conflicts: { aZone: string; bZone: string; at: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i];
        const b = segments[j];
        if (!a.groupId || !b.groupId || a.groupId === b.groupId) continue;
        if (!mutexPairs.has(`${a.groupId}|${b.groupId}`)) continue;
        if (a.start < b.worstEnd && b.start < a.worstEnd) {
          a.conflict = true;
          b.conflict = true;
          conflicts.push({ aZone: a.zoneId, bZone: b.zoneId, at: Math.max(a.start, b.start) });
        }
      }
    }
    return { segments: segments.sort((x, y) => x.start - y.start), envelopes: envelopes.sort((x, y) => x.start - y.start), conflicts };
  }

  /**
   * Weekly busy template for the schedule editor: for every other schedule,
   * per-weekday intervals (minutes from midnight) with worst-case length and
   * the rule relation to the group/zone being edited.
   */
  async busyWeek(exclude?: { kind: 'group' | 'zone'; id: string }) {
    const maxBoost = (await this.weather.maxBoostPct()) / 100;
    const ctxGroupId =
      exclude?.kind === 'group'
        ? exclude.id
        : exclude?.kind === 'zone'
          ? this.groups.find((g) => g.zoneIds.includes(exclude.id))?.id ?? null
          : null;

    const relationTo = (groupId: string | null): 'conflict' | 'info' => {
      if (!ctxGroupId || !groupId || groupId === ctxGroupId) return 'info';
      if (this.srcMutexPairs.has(`${ctxGroupId}|${groupId}`)) return 'conflict';
      for (const rule of this.rules) {
        if (rule.type === 'mutex' && rule.groups.includes(ctxGroupId) && rule.groups.includes(groupId)) return 'conflict';
        if (
          rule.type === 'order' &&
          rule.before &&
          rule.after &&
          [rule.before, rule.after].includes(ctxGroupId) &&
          [rule.before, rule.after].includes(groupId)
        )
          return 'conflict';
      }
      return 'info';
    };

    const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    // worstLenMin shifts finish-anchored starts earlier (start = finish − worst length)
    const expand = (schedule: import('../db/entities').Schedule, worstLenMin = 0): { dow: number; min: number }[] => {
      const out: { dow: number; min: number }[] = [];
      const toMin = (hhmm: string) => {
        const [h, m] = hhmm.split(':').map(Number);
        return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
      };
      const push = (dow: number, s: { start: string; anchor?: 'start' | 'finish' }) => {
        let min = toMin(s.start);
        if (min === null) return;
        if (s.anchor === 'finish') min -= worstLenMin;
        let d = dow;
        while (min < 0) {
          min += 1440;
          d = (d + 6) % 7;
        }
        out.push({ dow: d, min });
      };
      if (!inSeason(schedule.season ?? null, new Date())) return out; // out-of-season: no bands today
      if (schedule.mode === 'per_day') {
        DAY_KEYS.forEach((key, dow) => {
          for (const s of schedule.perDay?.[key] ?? []) push(dow, s);
        });
      } else {
        // mirror planner semantics: undefined = every day (legacy), empty array = no days
        for (const dow of schedule.weekdays ?? [0, 1, 2, 3, 4, 5, 6]) {
          for (const s of schedule.starts ?? []) push(dow, s);
        }
      }
      return out;
    };

    type Band = {
      dow: number;
      startMin: number;
      endMin: number;
      worstEndMin: number;
      groupId: string | null;
      label: string;
      relation: 'conflict' | 'info';
    };
    const bands: Band[] = [];
    /** Splits bands that cross midnight into a tail band on the next weekday. */
    const pushBand = (b: Band) => {
      if (b.worstEndMin <= 1440) {
        bands.push(b);
        return;
      }
      bands.push({ ...b, endMin: Math.min(b.endMin, 1440), worstEndMin: 1440 });
      bands.push({
        ...b,
        dow: (b.dow + 1) % 7,
        startMin: 0,
        endMin: Math.max(0, b.endMin - 1440),
        worstEndMin: b.worstEndMin - 1440,
      });
    };

    for (const group of this.groups.filter((g) => g.enabled)) {
      if (exclude?.kind === 'group' && group.id === exclude.id) continue;
      for (const schedule of (group.schedules ?? []).filter((s) => s.enabled)) {
        const zones = this.schedZones(group, schedule);
        if (!zones.length) continue;
        const durs = zones.map((z) =>
          Math.min(((schedule.zoneDurations?.[z.id] ?? z.baseDurationMin) * group.multiplierPct) / 100, z.maxRuntimeMin || 1e9),
        );
        const batch = group.mode === 'parallel' ? durs.length : group.mode === 'parallel_limit' ? Math.max(1, group.parallelLimit) : 1;
        let total = 0;
        for (let i = 0; i < durs.length; i += batch) total += Math.max(...durs.slice(i, i + batch)) + group.interZoneDelayS / 60;
        total = Math.max(0, total - group.interZoneDelayS / 60);
        for (const { dow, min } of expand(schedule, total * maxBoost)) {
          pushBand({
            dow,
            startMin: min,
            endMin: min + total,
            worstEndMin: min + total * maxBoost,
            groupId: group.id,
            label: group.name,
            relation: relationTo(group.id),
          });
        }
      }
    }

    for (const zone of this.zones.filter((z) => z.enabled && z.schedules?.length)) {
      if (exclude?.kind === 'zone' && zone.id === exclude.id) continue;
      const containing = this.groups.find((g) => g.zoneIds.includes(zone.id));
      for (const schedule of zone.schedules.filter((s) => s.enabled)) {
        const dur = Math.min(schedule.zoneDurations?.[zone.id] ?? zone.baseDurationMin, zone.maxRuntimeMin || 1e9);
        for (const { dow, min } of expand(schedule, dur * maxBoost)) {
          pushBand({
            dow,
            startMin: min,
            endMin: min + dur,
            worstEndMin: min + dur * maxBoost,
            groupId: containing?.id ?? null,
            label: `${zone.name} (zone)`,
            relation: relationTo(containing?.id ?? null),
          });
        }
      }
    }

    return { bands, worstFactor: maxBoost };
  }

  /** Human pause phrasing, e.g. "49 min (until 8:44 PM)" or "12h (until Tue 8:00 AM)". */
  private pausePhrase(hours: number): string {
    const until = Date.now() + hours * 3600_000;
    const mins = Math.round(hours * 60);
    const dur = mins < 60 ? `${mins} min` : mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 60)}h`;
    const t = new Date(until).toLocaleString(undefined, { weekday: mins >= 1440 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
    return `${dur} (until ${t})`;
  }

  /** Pause all automatic watering for `hours` (0 = resume now). Manual runs are unaffected. */
  async setGlobalPause(hours: number) {
    this.snoozeUntil = hours > 0 ? Date.now() + hours * 3600_000 : 0;
    await this.config.setKV('snoozeUntil', this.snoozeUntil);
    await this.journal.add('info', { code: 'pause', detail: hours > 0 ? `all watering paused for ${this.pausePhrase(hours)}` : 'pause cleared' });
    this.broadcastState();
  }

  /** Pause one group's automatic runs for `hours` (0 = resume). Manual runs still work. */
  async setGroupPause(groupId: string, hours: number) {
    const until = hours > 0 ? Date.now() + hours * 3600_000 : null;
    await this.groupsRepo.update({ id: groupId }, { snoozeUntil: until });
    const g = this.groups.find((x) => x.id === groupId);
    if (g) g.snoozeUntil = until;
    await this.journal.add('info', { groupId, code: 'group_pause', detail: hours > 0 ? `group paused for ${this.pausePhrase(hours)}` : 'group pause cleared' });
    this.broadcastState();
  }

  /** Pause one zone's automatic runs for `hours` (0 = resume). Manual runs still work. */
  async setZonePause(zoneId: string, hours: number) {
    const until = hours > 0 ? Date.now() + hours * 3600_000 : null;
    await this.zonesRepo.update({ id: zoneId }, { snoozeUntil: until });
    const z = this.zone(zoneId);
    if (z) z.snoozeUntil = until;
    await this.journal.add('info', { zoneId, code: 'zone_pause', detail: hours > 0 ? `zone paused for ${this.pausePhrase(hours)}` : 'zone pause cleared' });
    this.broadcastState();
  }

  /**
   * Sticky auto-allow for schedules/soil/heat. When false, automatic runs are skipped
   * with journal code `auto_disabled`. Manual "water now" still works.
   */
  async setZoneAutoAllow(zoneId: string, allow: boolean) {
    await this.zonesRepo.update({ id: zoneId }, { autoAllow: allow });
    const z = this.zone(zoneId);
    if (z) z.autoAllow = allow;
    await this.journal.add('info', {
      zoneId,
      code: allow ? 'auto_allow_on' : 'auto_allow_off',
      detail: allow ? 'automatic watering re-enabled' : 'automatic watering disabled by auto-allow switch',
    });
    this.broadcastState();
  }

  clearFault(zoneId: string) {
    this.faultZones.delete(zoneId);
    this.broadcastState();
  }

  snapshot() {
    const now = Date.now();
    return {
      now,
      paused: this.paused,
      snoozeUntil: this.snoozeUntil || null,
      haConnected: this.ha.connected,
      active: this.active.map((a) => ({
        zoneId: a.zoneId,
        zoneName: this.zone(a.zoneId)?.name ?? a.zoneId,
        groupId: a.groupId,
        startTs: a.startTs,
        endsAt: a.endsAt,
        plannedMin: a.plannedMin,
        manual: a.manual,
        triggeredBy: a.triggeredBy,
        progress: Math.min(1, (now - a.startTs) / Math.max(1, a.endsAt - a.startTs)),
      })),
      queue: this.queue.map((q) => ({
        key: q.key,
        zoneId: q.zoneId,
        zoneName: this.zone(q.zoneId)?.name ?? q.zoneId,
        groupId: q.groupId,
        durationMin: q.durationMin,
        manual: q.manual,
        seqIndex: q.seqIndex,
        waitReason: q.waitReason ?? (q.notBefore > now ? 'waiting for delay/soak' : 'queued'),
      })),
      /** Waiting manual sequential chain (same items as queue where manual=true). */
      manualQueue: this.queue
        .filter((q) => q.manual)
        .sort((a, b) => a.seqIndex - b.seqIndex || a.enqueuedAt - b.enqueuedAt)
        .map((q, i) => ({
          key: q.key,
          zoneId: q.zoneId,
          zoneName: this.zone(q.zoneId)?.name ?? q.zoneId,
          durationMin: q.durationMin,
          position: i + 1,
          waitReason: q.waitReason ?? 'manual queue',
        })),
      faults: [...this.faultZones],
      pumpStates: this.sources
        .filter((s) => s.pumpEntity)
        .map((s) => ({ sourceId: s.id, name: s.name, on: this.ha.isOn(s.pumpEntity!) })),
      sourceLevels: this.sources
        .filter((s) => s.capacityL)
        .map((s) => {
          const l = this.sourceLevelL(s.id);
          return {
            sourceId: s.id,
            name: s.name,
            capacityL: s.capacityL!,
            levelL: l !== null ? Math.round(l) : null,
            levelPct: l !== null ? Math.round((l / s.capacityL!) * 100) : null,
          };
        }),
    };
  }

  private broadcastState() {
    this.events.broadcast('engine', this.snapshot());
  }
}
