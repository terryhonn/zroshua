import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { EngineService } from '../engine/engine.service';
import { ConfigService } from '../config/config.service';
import { WeatherService } from '../weather/weather.service';
import { JournalService } from '../journal/journal.service';
import { MqttService } from '../mqtt/mqtt.service';
import { NotifyService } from '../notify/notify.service';
import { ADDON_VERSION } from '../version';

@Controller('api')
export class ActionsController {
  constructor(
    private readonly engine: EngineService,
    private readonly config: ConfigService,
    private readonly weather: WeatherService,
    private readonly journal: JournalService,
    private readonly mqtt: MqttService,
    private readonly notify: NotifyService,
  ) {}

  @Get('mqtt-status')
  mqttStatus() {
    return this.mqtt.status;
  }

  @Get('state')
  state() {
    return this.engine.snapshot();
  }

  @Get('upcoming')
  upcoming() {
    return this.engine.upcoming(7);
  }

  @Get('plan')
  plan(@Query('days') days = '7') {
    return this.engine.plan(Number(days) || 7);
  }

  @Get('busy-week')
  busyWeek(@Query('excludeKind') excludeKind?: 'group' | 'zone', @Query('excludeId') excludeId?: string) {
    return this.engine.busyWeek(excludeKind && excludeId ? { kind: excludeKind, id: excludeId } : undefined);
  }

  @Get('weather')
  weatherNow() {
    return this.weather.currentWeather();
  }

  @Get('health')
  health() {
    return { ok: true, version: ADDON_VERSION, ts: Date.now() };
  }

  @Get('version')
  version() {
    return { version: ADDON_VERSION };
  }

  @Get('journal')
  journalList() {
    return this.journal.list(300);
  }

  @Get('last-runs')
  lastRuns() {
    return this.engine.lastRuns();
  }

  @Get('zones/:id/next')
  async nextRun(@Param('id') id: string) {
    return { ts: await this.engine.nextRunTs(id) };
  }

  @Post('zones/:id/run')
  async runZone(@Param('id') id: string, @Body() body: { minutes?: number }) {
    return this.engine.startZoneManual(id, body?.minutes);
  }

  /** Remove a waiting entry from the sequential manual queue (by key from snapshot.manualQueue). */
  @Post('manual-queue/remove')
  async removeManualQueue(@Body() body: { key: string }) {
    if (!body?.key) throw new BadRequestException('key required');
    await this.engine.removeManualQueueItem(body.key);
    return { ok: true };
  }

  /** Clear all waiting manual-queue items (does not stop the zone currently watering). */
  @Post('manual-queue/clear')
  async clearManualQueue() {
    await this.engine.clearManualQueue();
    return { ok: true };
  }

  @Post('zones/:id/stop')
  async stopZone(@Param('id') id: string) {
    await this.engine.stopZone(id, 'manual_stop');
    return { ok: true };
  }

  @Post('zones/:id/extend')
  async extendZone(@Param('id') id: string, @Body() body: { minutes: number }) {
    if (!body?.minutes) throw new BadRequestException('minutes required');
    await this.engine.extendZone(id, body.minutes);
    return { ok: true };
  }

  @Post('zones/:id/clear-fault')
  clearFault(@Param('id') id: string) {
    this.engine.clearFault(id);
    return { ok: true };
  }

  @Post('groups/:id/run')
  async runGroup(@Param('id') id: string, @Body() body: { minutes?: number }) {
    const group = (await this.config.groups.findOneBy({ id }))!;
    if (!group) throw new BadRequestException('group not found');
    const enqueued = await this.engine.startGroupRun(group, 'manual', body?.minutes);
    return { ok: true, enqueued };
  }

  @Post('stop-all')
  async stopAll() {
    await this.engine.stopAll('manual_stop');
    return { ok: true };
  }

  @Post('snooze')
  async snooze(@Body() body: { hours: number }) {
    await this.engine.setGlobalPause(body?.hours ?? 0);
    return { ok: true };
  }

  @Post('groups/:id/pause')
  async pauseGroup(@Param('id') id: string, @Body() body: { hours: number }) {
    await this.engine.setGroupPause(id, body?.hours ?? 0);
    return { ok: true };
  }

  @Post('zones/:id/pause')
  async pauseZone(@Param('id') id: string, @Body() body: { hours: number }) {
    await this.engine.setZonePause(id, body?.hours ?? 0);
    return { ok: true };
  }

  /** Sticky auto-allow for schedules (manual runs ignore). HA automations can flip this via MQTT switch. */
  @Post('zones/:id/auto-allow')
  async autoAllowZone(@Param('id') id: string, @Body() body: { allow: boolean }) {
    await this.engine.setZoneAutoAllow(id, body?.allow !== false);
    return { ok: true, allow: body?.allow !== false };
  }

  @Post('pause')
  pause(@Body() body: { paused: boolean }) {
    this.engine.paused = !!body?.paused;
    return { ok: true, paused: this.engine.paused };
  }

  /** Send today's digest now, labelled as a test. Does not consume the daily slot. */
  @Post('notifications/test-digest')
  testDigest() {
    return this.engine.sendDigest({ test: true });
  }

  /** Ping a single HA notify service (the one typed in Settings, even if not saved). */
  @Post('notifications/test-ha')
  async testHa(@Body() body: { service?: string }) {
    const service = String(body?.service ?? '').trim();
    if (!service) return { ok: false, reason: 'Notify service is empty' };
    try {
      await this.notify.testHa(service);
      return { ok: true, service };
    } catch (e: any) {
      return { ok: false, reason: e.message ?? 'HA notify failed' };
    }
  }
}
