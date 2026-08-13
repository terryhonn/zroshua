import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  FileButton,
  Group,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api, Group as ZGroup, NotificationProvider, Settings } from '../api';
import { useResource } from '../hooks';
import { EntitySelect, SliderInput } from '../components/common';
import { LANG_OPTIONS, setLang, storedLang, t } from '../i18n';
import { HintLabel, HintTitle } from '../components/Hint';
import { TempUnit, VolumeUnit, displayFlow, displayTemp, flowSuffix, tempSuffix, toStoredC, toStoredL } from '../units';

const EVENTS = [
  { value: 'run_start', label: t('Run started') },
  { value: 'run_end', label: t('Run ended') },
  { value: 'skip', label: t('Skipped') },
  { value: 'stop_rain', label: t('Stopped by rain') },
  { value: 'fault', label: t('Fault') },
  { value: 'system', label: t('System') },
];

interface MqttStatus {
  configured: boolean;
  connected: boolean;
  broker: string | null;
  source: string;
  detail: string;
}

/** Surfaces whether the MQTT bridge (Lovelace cards + entities) is working. */
function MqttStatusBanner() {
  const { data } = useResource<MqttStatus>('/mqtt-status');
  if (!data) return null;
  const color = data.connected ? 'teal' : data.configured ? 'yellow' : 'gray';
  const label = data.connected
    ? t('MQTT connected ({broker}, via {source}) — Lovelace cards & entities are live', { broker: data.broker ?? '', source: data.source })
    : data.configured
      ? t('MQTT configured ({broker}) but not connected: {detail}', { broker: data.broker ?? '', detail: data.detail })
      : t('MQTT off — Lovelace cards and HA entities are unavailable. {detail}', { detail: data.detail });
  return (
    <Alert color={color} title={t('Home Assistant integration (MQTT)')}>
      {label}
    </Alert>
  );
}

export default function SettingsPage() {
  const { data: settings, reload } = useResource<Settings>('/settings');
  const { data: groups } = useResource<ZGroup[]>('/groups');
  const { data: health } = useResource<{ ok: boolean; version?: string }>('/health');
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setS(settings);
  }, [settings]);

  if (!s) return null;

  const unit: TempUnit = s.tempUnit === 'F' ? 'F' : 'C';
  const volUnit: VolumeUnit = s.volumeUnit === 'gal' ? 'gal' : 'L';
  const deg = tempSuffix(unit);
  const flowUnit = flowSuffix(volUnit);

  const save = async () => {
    try {
      await api.put('/settings', s);
      notifications.show({ message: t('Settings saved'), color: 'teal' });
      reload();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  /** Persist temp unit immediately (same card as Language — no need to hit Save settings). */
  const setTempUnit = async (next: TempUnit) => {
    const patched = { ...s, tempUnit: next };
    setS(patched);
    try {
      await api.put('/settings', patched);
      notifications.show({ message: t('Temperature unit saved'), color: 'teal' });
      reload();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  /** Persist volume unit immediately (same card as Language). */
  const setVolumeUnit = async (next: VolumeUnit) => {
    const patched = { ...s, volumeUnit: next };
    setS(patched);
    try {
      await api.put('/settings', patched);
      notifications.show({ message: t('Volume unit saved'), color: 'teal' });
      reload();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  const exportConfig = async () => {
    const data = await api.get('/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zroshua-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  const importConfig = async (file: File | null) => {
    if (!file) return;
    try {
      await api.post('/import', JSON.parse(await file.text()));
      notifications.show({ message: t('Configuration imported'), color: 'teal' });
      reload();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  const testDigest = async () => {
    setTesting('digest');
    try {
      await api.put('/settings', s);
      reload();
      const res = await api.post<{ ok: boolean; sent: number; attempted: number; reason?: string }>('/notifications/test-digest');
      if (res.ok) {
        notifications.show({ message: t('Test digest sent to {n} provider(s)', { n: res.sent }), color: 'teal' });
      } else {
        notifications.show({ message: res.reason ?? t('Test digest was not delivered'), color: 'red' });
      }
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    } finally {
      setTesting(null);
    }
  };

  const testHa = async (service: string, key: string) => {
    setTesting(key);
    try {
      const res = await api.post<{ ok: boolean; reason?: string; service?: string }>('/notifications/test-ha', { service });
      if (res.ok) {
        notifications.show({ message: t('Test sent to {service}', { service: res.service ?? service }), color: 'teal' });
      } else {
        notifications.show({ message: res.reason ?? t('HA notify test failed'), color: 'red' });
      }
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    } finally {
      setTesting(null);
    }
  };

  const setProvider = (i: number, patch: Partial<NotificationProvider>) => {
    const providers = [...s.notifications.providers];
    providers[i] = { ...providers[i], ...patch } as NotificationProvider;
    setS({ ...s, notifications: { ...s.notifications, providers } });
  };

  return (
    <Stack>
      <Group justify="space-between" align="baseline" wrap="wrap">
        <Title order={3}>{t('Settings')}</Title>
        {health?.version && (
          <Text size="sm" c="dimmed" title={t('Add-on version from /api/health')}>
            {t('Version {version}', { version: health.version })}
          </Text>
        )}
      </Group>

      <MqttStatusBanner />

      <Card withBorder>
        <Group grow align="flex-start" wrap="wrap">
          <Select
            label={<HintLabel label={t('Language')} hint={t('Home Assistant does not share your account language with add-ons, so this follows your device by default — override it here.')} />}
            data={LANG_OPTIONS}
            value={storedLang()}
            onChange={(v) => v && setLang(v)}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            label={
              <HintLabel
                label={t('Temperature unit')}
                hint={t('Used for weather, freeze protect, temperature scaling, heat triggers and forecast conditions. Values are stored in °C internally; this only changes how they are shown and entered.')}
              />
            }
            data={[
              { value: 'C', label: t('Celsius (°C)') },
              { value: 'F', label: t('Fahrenheit (°F)') },
            ]}
            value={unit}
            onChange={(v) => v && setTempUnit(v as TempUnit)}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            label={
              <HintLabel
                label={t('Volume unit')}
                hint={t('Used for water totals, flow rates, barrel capacity and MQTT water sensors. Values are stored in liters / L/min internally; this only changes how they are shown and entered. Gallons are US liquid gallons.')}
              />
            }
            data={[
              { value: 'L', label: t('Liters (L)') },
              { value: 'gal', label: t('US gallons (gal)') },
            ]}
            value={volUnit}
            onChange={(v) => v && setVolumeUnit(v as VolumeUnit)}
            comboboxProps={{ withinPortal: true }}
          />
        </Group>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('Weather triggers')}
        </Title>
        <Stack>
          <EntitySelect
            label={<HintLabel label={t('Weather entity')} hint={t('default: first weather.* in HA')} />}
            value={s.weatherEntity}
            onChange={(v) => setS({ ...s, weatherEntity: v })}
            domains={['weather']}
          />
          <Switch
            label={t('Skip watering based on rain forecast')}
            checked={s.weatherTriggers.enabled}
            onChange={(e) => setS({ ...s, weatherTriggers: { ...s.weatherTriggers, enabled: e.currentTarget.checked } })}
          />
          <Group grow>
            <SliderInput
              label={t('Rain probability threshold')}
              value={s.weatherTriggers.rainProbPct}
              onChange={(v) => setS({ ...s, weatherTriggers: { ...s.weatherTriggers, rainProbPct: v } })}
              min={10}
              max={100}
              unit="%"
            />
            <SliderInput
              label={t('Forecast rain amount threshold')}
              value={s.weatherTriggers.rainAmountMm}
              onChange={(v) => setS({ ...s, weatherTriggers: { ...s.weatherTriggers, rainAmountMm: v } })}
              min={0}
              max={20}
              step={0.5}
              unit="mm"
            />
          </Group>
          <NumberInput
            label={<HintLabel label={t('Freeze protect below')} hint={t('{unit}, empty = off', { unit: deg })} />}
            suffix={deg}
            value={s.weatherTriggers.freezeC == null ? '' : displayTemp(s.weatherTriggers.freezeC, unit)}
            onChange={(v) =>
              setS({
                ...s,
                weatherTriggers: {
                  ...s.weatherTriggers,
                  freezeC: v === '' ? null : toStoredC(v, unit),
                },
              })
            }
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('Temperature scaling (%)')}
        </Title>
        <Stack>
          <Switch
            label={t('Enabled')}
            checked={s.tempScale.enabled}
            onChange={(e) => setS({ ...s, tempScale: { ...s.tempScale, enabled: e.currentTarget.checked } })}
          />
          <MultiSelect
            label={<HintLabel label={t('Applies to groups')} hint={t('empty = all')} />}
            data={(groups ?? []).map((g) => ({ value: g.id, label: g.name }))}
            value={s.tempScale.groups}
            onChange={(v) => setS({ ...s, tempScale: { ...s.tempScale, groups: v } })}
          />
          <Group grow>
            <Select
              label={t('Temperature input')}
              data={[
                { value: 'forecast_only', label: t('Today\'s forecast max') },
                { value: 'sensor_only', label: t('Yesterday\'s sensor max') },
                { value: 'max', label: t('Max of both (safe in heat)') },
                { value: 'avg', label: t('Average of both') },
              ]}
              value={s.tempScale.combine}
              onChange={(v) => setS({ ...s, tempScale: { ...s.tempScale, combine: (v as any) ?? 'max' } })}
            />
            <EntitySelect
              label={<HintLabel label={t('Local temperature sensor')} hint={t('yesterday\'s max')} />}
              value={s.tempScale.yesterdaySensor}
              onChange={(v) => setS({ ...s, tempScale: { ...s.tempScale, yesterdaySensor: v } })}
              domains={['sensor']}
            />
          </Group>
          <Stack gap={4}>
            <Text size="sm">{t('Steps')}</Text>
            {s.tempScale.steps.map((st, i) => (
              <Group key={i} gap="xs">
                <Select
                  w={110}
                  size="xs"
                  data={[
                    { value: 'below', label: t('Below') },
                    { value: 'above', label: t('Above') },
                  ]}
                  value={st.belowC !== undefined ? 'below' : 'above'}
                  onChange={(v) => {
                    const steps = [...s.tempScale.steps];
                    const threshold = st.belowC ?? st.aboveC ?? 20; // already °C in storage
                    steps[i] = v === 'below' ? { ...st, belowC: threshold, aboveC: undefined } : { ...st, aboveC: threshold, belowC: undefined };
                    setS({ ...s, tempScale: { ...s.tempScale, steps } });
                  }}
                />
                <NumberInput
                  w={100}
                  size="xs"
                  suffix={deg}
                  value={displayTemp(st.belowC ?? st.aboveC ?? 20, unit)}
                  onChange={(v) => {
                    const steps = [...s.tempScale.steps];
                    const stored = toStoredC(v, unit) ?? 20;
                    steps[i] = st.belowC !== undefined ? { ...st, belowC: stored } : { ...st, aboveC: stored };
                    setS({ ...s, tempScale: { ...s.tempScale, steps } });
                  }}
                />
                <Select
                  w={110}
                  size="xs"
                  data={[
                    { value: 'pct', label: t('Adjust %') },
                    { value: 'skip', label: t('Skip day') },
                  ]}
                  value={st.action === 'skip' ? 'skip' : 'pct'}
                  onChange={(v) => {
                    const steps = [...s.tempScale.steps];
                    steps[i] = v === 'skip' ? { ...st, action: 'skip', pct: undefined } : { ...st, action: undefined, pct: st.pct ?? 0 };
                    setS({ ...s, tempScale: { ...s.tempScale, steps } });
                  }}
                />
                {st.action !== 'skip' && (
                  <NumberInput
                    w={90}
                    size="xs"
                    suffix="%"
                    value={st.pct ?? 0}
                    onChange={(v) => {
                      const steps = [...s.tempScale.steps];
                      steps[i] = { ...st, pct: Number(v) };
                      setS({ ...s, tempScale: { ...s.tempScale, steps } });
                    }}
                  />
                )}
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => setS({ ...s, tempScale: { ...s.tempScale, steps: s.tempScale.steps.filter((_, j) => j !== i) } })}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              size="xs"
              variant="light"
              w={140}
              onClick={() => setS({ ...s, tempScale: { ...s.tempScale, steps: [...s.tempScale.steps, { aboveC: 30, pct: 30 }] } })}
            >
              {t('Add step')}
            </Button>
          </Stack>
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('Notifications')}
        </Title>
        <Stack>
          <Switch
            label={<HintLabel label={t('One message per group run')} hint={t('A group start/finish summary (zones, time, water) instead of a message per zone')} />}
            checked={s.notifications.groupLevel ?? true}
            onChange={(e) => setS({ ...s, notifications: { ...s.notifications, groupLevel: e.currentTarget.checked } })}
          />
          <Group align="flex-end" wrap="wrap" gap="md">
            <Switch
              style={{ minWidth: 240 }}
              pb={8}
              label={<HintLabel label={t('Daily digest')} hint={t('Evening summary sent to every provider at this time. Not blocked by quiet hours or the event filter.')} />}
              checked={s.notifications.digest?.enabled ?? false}
              onChange={(e) =>
                setS({ ...s, notifications: { ...s.notifications, digest: { ...s.notifications.digest, enabled: e.currentTarget.checked } } })
              }
            />
            <TextInput
              type="time"
              w={150}
              label={t('Digest time')}
              disabled={!(s.notifications.digest?.enabled ?? false)}
              value={s.notifications.digest?.time ?? '21:00'}
              onChange={(e) =>
                e.target.value &&
                setS({ ...s, notifications: { ...s.notifications, digest: { ...s.notifications.digest, time: e.target.value.slice(0, 5) } } })
              }
            />
            <Button
              variant="light"
              disabled={testing !== null}
              loading={testing === 'digest'}
              onClick={testDigest}
            >
              {t('Send test digest')}
            </Button>
          </Group>
          <Group align="flex-end" wrap="wrap" gap="md">
            <Switch
              style={{ minWidth: 240 }}
              pb={8}
              label={<HintLabel label={t('Quiet hours')} hint={t('Suppress all but fault alerts and the daily digest in this window')} />}
              checked={s.notifications.quiet?.enabled ?? false}
              onChange={(e) =>
                setS({ ...s, notifications: { ...s.notifications, quiet: { ...s.notifications.quiet, enabled: e.currentTarget.checked } } })
              }
            />
            <TextInput
              type="time"
              w={150}
              label={t('From')}
              disabled={!(s.notifications.quiet?.enabled ?? false)}
              value={s.notifications.quiet?.from ?? '22:00'}
              onChange={(e) =>
                e.target.value && setS({ ...s, notifications: { ...s.notifications, quiet: { ...s.notifications.quiet, from: e.target.value } } })
              }
            />
            <TextInput
              type="time"
              w={150}
              label={t('To')}
              disabled={!(s.notifications.quiet?.enabled ?? false)}
              value={s.notifications.quiet?.to ?? '07:00'}
              onChange={(e) =>
                e.target.value && setS({ ...s, notifications: { ...s.notifications, quiet: { ...s.notifications.quiet, to: e.target.value } } })
              }
            />
          </Group>
          {s.notifications.providers.map((p, i) => (
            <Card key={i} withBorder p="sm">
              <Group justify="space-between" mb="xs">
                <Text fw={600}>{p.type === 'telegram' ? 'Telegram' : t('Home Assistant notify')}</Text>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() =>
                    setS({ ...s, notifications: { ...s.notifications, providers: s.notifications.providers.filter((_, j) => j !== i) } })
                  }
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              {p.type === 'telegram' ? (
                <TextInput
                  label={<HintLabel label={t('Chat IDs')} hint={t('comma separated; bot token is set in add-on options')} />}
                  value={p.chatIds.join(',')}
                  onChange={(e) => setProvider(i, { chatIds: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } as any)}
                />
              ) : (
                <Group align="flex-end" wrap="wrap" gap="sm">
                  <TextInput
                    style={{ flex: 1, minWidth: 220 }}
                    label={<HintLabel label={t('Notify service')} hint={t('e.g. notify.mobile_app_phone')} />}
                    value={p.service}
                    onChange={(e) => setProvider(i, { service: e.target.value } as any)}
                  />
                  <Button
                    variant="light"
                    disabled={!p.service?.trim() || testing !== null}
                    loading={testing === `ha:${i}`}
                    onClick={() => testHa(p.service, `ha:${i}`)}
                  >
                    {t('Test notify')}
                  </Button>
                </Group>
              )}
              <MultiSelect
                label={<HintLabel label={t('Events')} hint={t('empty = all realtime events. The daily digest is always sent when enabled.')} />}
                data={EVENTS}
                value={p.events}
                onChange={(v) => setProvider(i, { events: v } as any)}
                mt="xs"
              />
            </Card>
          ))}
          <Group>
            <Button
              variant="light"
              onClick={() =>
                setS({
                  ...s,
                  notifications: { ...s.notifications, providers: [...s.notifications.providers, { type: 'telegram', chatIds: [], events: [] }] },
                })
              }
            >
              {t('Add Telegram')}
            </Button>
            <Button
              variant="light"
              onClick={() =>
                setS({
                  ...s,
                  notifications: {
                    ...s.notifications,
                    providers: [...s.notifications.providers, { type: 'ha_notify', service: 'notify.notify', events: [] }],
                  },
                })
              }
            >
              {t('Add HA notify')}
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('Limits & misc')}
        </Title>
        <Stack>
          <Group grow>
            <NumberInput
              label={<HintLabel label={t('Global max total flow')} hint={t('{unit}, empty = off', { unit: flowUnit })} />}
              suffix={` ${flowUnit}`}
              value={s.maxTotalFlowLpm != null ? displayFlow(s.maxTotalFlowLpm, volUnit) : ''}
              onChange={(v) => setS({ ...s, maxTotalFlowLpm: v === '' ? null : toStoredL(v, volUnit) })}
              decimalScale={volUnit === 'gal' ? 2 : 1}
            />
            <NumberInput
              label={<HintLabel label={t('Energy tariff per kWh')} hint={t('for cost stats')} />}
              value={s.energyTariffPerKwh ?? ''}
              onChange={(v) => setS({ ...s, energyTariffPerKwh: v === '' ? null : Number(v) })}
            />
            <TextInput
              label={<HintLabel label={t('Currency')} hint={t('shown in statistics')} />}
              placeholder="₴ / € / $"
              value={s.energyCurrency ?? ''}
              onChange={(e) => setS({ ...s, energyCurrency: e.target.value || null })}
            />
          </Group>
          <Select
            label={
              <HintLabel
                label={t('When a scheduled run conflicts with group rules')}
                hint={
                  <>
                    {t('never-overlap / order')}
                    <br />
                    <br />
                    {t('Wait = start as soon as the other group finishes (default). Skip = if it cannot start on time, skip it and log the reason.')}
                  </>
                }
              />
            }
            data={[
              { value: 'wait', label: t('Wait in queue (run later)') },
              { value: 'skip', label: t('Skip the run (strict timetable)') },
            ]}
            value={s.conflictPolicy}
            onChange={(v) => setS({ ...s, conflictPolicy: (v as any) ?? 'wait' })}
          />
          <Group align="flex-end" wrap="wrap" gap="md">
            <Switch
              style={{ minWidth: 300 }}
              pb={8}
              label={<HintLabel label={t('Check entity availability before scheduled starts')} hint={t('If a zone\'s switch/valve entity (or its source pump) is unavailable within the lead window before a scheduled start, you get a fault notification with the exact entity — time to fix the controller.')} />}
              checked={s.preStartCheck?.enabled ?? true}
              onChange={(e) => setS({ ...s, preStartCheck: { minutes: s.preStartCheck?.minutes ?? 30, enabled: e.currentTarget.checked } })}
            />
            <NumberInput
              label={t('Lead time')}
              suffix={` ${t('min')}`}
              w={150}
              min={1}
              max={720}
              disabled={!(s.preStartCheck?.enabled ?? true)}
              value={s.preStartCheck?.minutes ?? 30}
              onChange={(v) => setS({ ...s, preStartCheck: { enabled: s.preStartCheck?.enabled ?? true, minutes: Number(v) || 30 } })}
            />
          </Group>
          <Select
            label={t('If a zone is switched on outside Zroshua')}
            data={[
              { value: 'adopt', label: t('Adopt as a manual run (auto-off by timer)') },
              { value: 'turn_off', label: t('Turn it off and warn') },
            ]}
            value={s.externalOnPolicy}
            onChange={(v) => setS({ ...s, externalOnPolicy: (v as any) ?? 'adopt' })}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <HintTitle
          title={t('Backup')}
          hint={t('With the default SQLite database everything lives in /data, which is included in Home Assistant backups.')}
        />
        <Group>
          <Button variant="light" onClick={exportConfig}>
            {t('Export configuration (JSON)')}
          </Button>
          <FileButton onChange={importConfig} accept="application/json">
            {(props) => (
              <Button {...props} variant="light" color="orange">
                {t('Import configuration')}
              </Button>
            )}
          </FileButton>
        </Group>
      </Card>

      <Button onClick={save} size="md">
        {t('Save settings')}
      </Button>
    </Stack>
  );
}
