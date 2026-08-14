import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  ActionIcon,
} from '@mantine/core';
import { IconDroplet, IconEdit, IconPlayerStop, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api, EngineState, Settings, WaterSource, Zone } from '../api';
import { useResource, fmtDur, fmtAgo } from '../hooks';
import { t } from '../i18n';
import { EntityMultiSelect, EntitySelect, SliderInput, PauseControl } from '../components/common';
import ScheduleEditor, { emptySchedule } from '../components/ScheduleEditor';
import { BusyBand, overlapsConflict, toMin } from '../components/TimeSlotPicker';
import { HintLabel, HintTitle } from '../components/Hint';
import {
  DEFAULT_FLOW_LPM,
  DEFAULT_FLOW_RANGE_LPM,
  displayFlow,
  flowSuffix,
  toStoredL,
  VolumeUnit,
} from '../units';

const emptyZone: Partial<Zone> = {
  name: '',
  type: 'sprinkler',
  entities: [],
  sourceId: null,
  flowLpm: null,
  baseDurationMin: 15,
  minDurationMin: 0,
  maxRuntimeMin: 60,
  ignore: {},
  cycleSoak: null,
  svgElementId: null,
  soilSensor: null,
  schedules: [],
  enabled: true,
  autoAllow: true,
  autoAllowEntity: null,
};

export default function ZonesPage({ state }: { state: EngineState | null }) {
  const { data: zones, reload } = useResource<Zone[]>('/zones');
  const { data: sources } = useResource<WaterSource[]>('/sources');
  const { data: settings } = useResource<Settings>('/settings');
  const { data: lastRuns } = useResource<{ zones: Record<string, number>; groups: Record<string, number> }>('/last-runs');
  const [editing, setEditing] = useState<Partial<Zone> | null>(null);
  const [runZone, setRunZone] = useState<Zone | null>(null);
  const [runMinutes, setRunMinutes] = useState(15);
  const [flowMode, setFlowMode] = useState<'none' | 'value' | 'range'>('none');
  const [busy, setBusy] = useState<BusyBand[]>([]);

  const volUnit: VolumeUnit = settings?.volumeUnit === 'gal' ? 'gal' : 'L';
  const flowUnit = flowSuffix(volUnit);

  const running = new Set(state?.active.map((a) => a.zoneId));
  const faults = new Set(state?.faults ?? []);

  const fmtFlow = (f: number | { min: number; max: number }) =>
    typeof f === 'number'
      ? String(displayFlow(f, volUnit))
      : `${displayFlow(f.min, volUnit)}–${displayFlow(f.max, volUnit)}`;

  const notifyErr = (e: any) => notifications.show({ message: e.message, color: 'red' });

  const worstFactor = settings?.tempScale.enabled
    ? 1 + settings.tempScale.steps.reduce((acc, st) => acc + Math.max(0, st.pct ?? 0), 0) / 100
    : 1;

  const zoneConflicts = (z: Partial<Zone>): string[] => {
    const out: string[] = [];
    const zid = z.id ?? 'new';
    for (const sch of (z.schedules ?? []).filter((x) => x.enabled)) {
      const dur = Math.max(1, (sch.zoneDurations?.[zid] ?? z.baseDurationMin ?? 15) * worstFactor);
      const entries =
        sch.mode === 'per_day'
          ? Object.entries(sch.perDay ?? {}).flatMap(([d, list]) =>
              (list ?? []).map((x) => ({ dows: [{ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[d] ?? 0], start: x.start })),
            )
          : (sch.starts ?? []).map((x) => ({ dows: sch.weekdays ?? [], start: x.start }));
      for (const e of entries) {
        const hit = overlapsConflict(toMin(e.start), dur, busy.filter((b) => e.dows.includes(b.dow)));
        if (hit) out.push(t('{start} overlaps "{label}"', { start: e.start, label: hit.label }));
      }
    }
    return out;
  };

  const save = async () => {
    if (!editing?.name) return;
    try {
      const conflicts = zoneConflicts(editing);
      if (editing.id) await api.put(`/zones/${editing.id}`, editing);
      else await api.post('/zones', editing);
      if (conflicts.length)
        notifications.show({
          title: t('Saved with rule conflicts'),
          message: t('{conflicts} — see the Timeline page.', { conflicts: conflicts.join('; ') }),
          color: 'red',
          autoClose: 10000,
        });
      setEditing(null);
      reload();
    } catch (e) {
      notifyErr(e);
    }
  };

  const openEdit = (z: Partial<Zone>) => {
    setEditing({ ...z });
    setFlowMode(z.flowLpm == null ? 'none' : typeof z.flowLpm === 'number' ? 'value' : 'range');
    setBusy([]);
    const q = z.id ? `?excludeKind=zone&excludeId=${z.id}` : '';
    api.get<{ bands: BusyBand[] }>(`/busy-week${q}`).then((r) => setBusy(r.bands)).catch(() => setBusy([]));
  };

  const startRun = async () => {
    if (!runZone) return;
    try {
      const res = await api.post<{ warnings?: string[]; queued?: boolean }>(`/zones/${runZone.id}/run`, {
        minutes: runMinutes,
      });
      if (res.queued) {
        notifications.show({
          message: t('Queued "{name}" for {minutes} min (manual queue)', {
            name: runZone.name,
            minutes: runMinutes,
          }),
          color: 'blue',
        });
      } else {
        notifications.show({
          message: t('Watering "{name}" for {minutes} min', { name: runZone.name, minutes: runMinutes }),
          color: 'teal',
        });
      }
      if (res.warnings?.length)
        notifications.show({ title: t('Started with warnings'), message: res.warnings.join('; '), color: 'yellow' });
      setRunZone(null);
    } catch (e) {
      notifyErr(e);
    }
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>{t('Zones')}</Title>
        <Button onClick={() => openEdit(emptyZone)}>{t('Add zone')}</Button>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {(zones ?? []).map((z) => (
          <Card key={z.id} withBorder opacity={z.enabled ? 1 : 0.5}>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <Text fw={600}>{z.name}</Text>
                {running.has(z.id) && <Badge color="teal">{t('watering')}</Badge>}
                {!!z.snoozeUntil && z.snoozeUntil > Date.now() && (
                  <Badge color="orange" variant="light">
                    {t('paused')}
                  </Badge>
                )}
                {z.autoAllow === false && (
                  <Badge color="gray" variant="light" title={t('Automatic schedules are blocked for this zone')}>
                    {t('auto off')}
                  </Badge>
                )}
                {faults.has(z.id) && (
                  <Badge
                    color="red"
                    style={{ cursor: 'pointer' }}
                    onClick={() => api.post(`/zones/${z.id}/clear-fault`).then(() => reload())}
                    title={t('Click to clear fault')}
                  >
                    {t('fault ✕')}
                  </Badge>
                )}
              </Group>
              <Group gap={4}>
                <PauseControl path={`/zones/${z.id}`} pausedUntil={z.snoozeUntil} onChange={reload} />
                <ActionIcon variant="subtle" onClick={() => openEdit(z)}>
                  <IconEdit size={18} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => api.del(`/zones/${z.id}`).then(reload).catch(notifyErr)}
                >
                  <IconTrash size={18} />
                </ActionIcon>
              </Group>
            </Group>
            <Text size="sm" c="dimmed">
              {t(z.type)} · {fmtDur(z.baseDurationMin)}
              {z.flowLpm != null && ` · ${t('{flow} {unit}', { flow: fmtFlow(z.flowLpm), unit: flowUnit })}`}
              {z.sourceId && ` · ${sources?.find((s) => s.id === z.sourceId)?.name ?? z.sourceId}`}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={1} style={{ wordBreak: 'break-all' }}>
              {z.entities.join(', ') || t('no entities')}
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              {t('Last watered:')} {fmtAgo(lastRuns?.zones[z.id])}
            </Text>
            {running.has(z.id) ? (
              <Button
                fullWidth
                color="red"
                variant="light"
                leftSection={<IconPlayerStop size={16} />}
                onClick={() => api.post(`/zones/${z.id}/stop`).catch(notifyErr)}
              >
                {t('Stop')}
              </Button>
            ) : (
              <Button
                fullWidth
                variant="light"
                leftSection={<IconDroplet size={16} />}
                onClick={() => {
                  setRunZone(z);
                  setRunMinutes(Math.round(z.baseDurationMin));
                }}
              >
                {t('Water now')}
              </Button>
            )}
          </Card>
        ))}
      </SimpleGrid>

      <Modal opened={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t('Edit zone') : t('New zone')} size="lg">
        {editing && (
          <Stack>
            <TextInput label={t('Name')} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            <Group grow>
              <Select
                label={t('Type')}
                data={[
                  { value: 'sprinkler', label: t('sprinkler') },
                  { value: 'drip', label: t('drip') },
                  { value: 'beds', label: t('beds') },
                  { value: 'lawn', label: t('lawn') },
                  { value: 'shrubs', label: t('shrubs') },
                ]}
                value={editing.type ?? 'sprinkler'}
                onChange={(v) => setEditing({ ...editing, type: v ?? 'sprinkler' })}
              />
              <Select
                label={t('Water source')}
                data={(sources ?? []).map((s) => ({ value: s.id, label: s.name }))}
                value={editing.sourceId}
                onChange={(v) => setEditing({ ...editing, sourceId: v })}
                clearable
              />
            </Group>
            <EntityMultiSelect
              label={<HintLabel label={t('Controlled entities')} hint={t('switch / valve')} />}
              value={editing.entities ?? []}
              onChange={(v) => setEditing({ ...editing, entities: v })}
              domains={['switch', 'valve', 'input_boolean', 'light']}
            />
            <SliderInput
              label={t('Default duration')}
              value={editing.baseDurationMin ?? 15}
              onChange={(v) => setEditing({ ...editing, baseDurationMin: v })}
              max={180}
            />
            <Group grow>
              <NumberInput
                label={<HintLabel label={t('Min duration')} hint={t('rollover threshold, min')} />}
                value={editing.minDurationMin ?? 0}
                onChange={(v) => setEditing({ ...editing, minDurationMin: Number(v) || 0 })}
              />
              <NumberInput
                label={t('Max runtime failsafe (min)')}
                value={editing.maxRuntimeMin ?? 60}
                onChange={(v) => setEditing({ ...editing, maxRuntimeMin: Number(v) || 60 })}
              />
            </Group>
            <Select
              label={t('Flow rate')}
              data={[
                { value: 'none', label: t('Unknown') },
                { value: 'value', label: t('Exact value') },
                { value: 'range', label: t('Range (min–max)') },
              ]}
              value={flowMode}
              onChange={(v) => {
                const mode = (v ?? 'none') as typeof flowMode;
                setFlowMode(mode);
                setEditing({
                  ...editing,
                  flowLpm: mode === 'none' ? null : mode === 'value' ? DEFAULT_FLOW_LPM : { ...DEFAULT_FLOW_RANGE_LPM },
                });
              }}
            />
            {flowMode === 'value' && (
              <NumberInput
                label={t('Flow ({unit})', { unit: flowUnit })}
                suffix={` ${flowUnit}`}
                value={typeof editing.flowLpm === 'number' ? displayFlow(editing.flowLpm, volUnit) : displayFlow(DEFAULT_FLOW_LPM, volUnit)}
                onChange={(v) => setEditing({ ...editing, flowLpm: toStoredL(v, volUnit) ?? 0 })}
                decimalScale={volUnit === 'gal' ? 2 : 1}
              />
            )}
            {flowMode === 'range' && (
              <Group grow>
                <NumberInput
                  label={t('Flow min ({unit})', { unit: flowUnit })}
                  suffix={` ${flowUnit}`}
                  value={
                    typeof editing.flowLpm === 'object' && editing.flowLpm
                      ? displayFlow(editing.flowLpm.min, volUnit)
                      : displayFlow(DEFAULT_FLOW_RANGE_LPM.min, volUnit)
                  }
                  onChange={(v) =>
                    setEditing({
                      ...editing,
                      flowLpm: {
                        min: toStoredL(v, volUnit) ?? 0,
                        max:
                          typeof editing.flowLpm === 'object' && editing.flowLpm
                            ? editing.flowLpm.max
                            : DEFAULT_FLOW_RANGE_LPM.max,
                      },
                    })
                  }
                  decimalScale={volUnit === 'gal' ? 2 : 1}
                />
                <NumberInput
                  label={t('Flow max ({unit})', { unit: flowUnit })}
                  suffix={` ${flowUnit}`}
                  value={
                    typeof editing.flowLpm === 'object' && editing.flowLpm
                      ? displayFlow(editing.flowLpm.max, volUnit)
                      : displayFlow(DEFAULT_FLOW_RANGE_LPM.max, volUnit)
                  }
                  onChange={(v) =>
                    setEditing({
                      ...editing,
                      flowLpm: {
                        min:
                          typeof editing.flowLpm === 'object' && editing.flowLpm
                            ? editing.flowLpm.min
                            : DEFAULT_FLOW_RANGE_LPM.min,
                        max: toStoredL(v, volUnit) ?? 0,
                      },
                    })
                  }
                  decimalScale={volUnit === 'gal' ? 2 : 1}
                />
              </Group>
            )}
            <Group grow>
              <NumberInput
                label={t('Cycle max (min, 0 = off)')}
                value={editing.cycleSoak?.max_cycle_min ?? 0}
                onChange={(v) =>
                  setEditing({
                    ...editing,
                    cycleSoak: Number(v) ? { max_cycle_min: Number(v), min_soak_min: editing.cycleSoak?.min_soak_min ?? 15 } : null,
                  })
                }
              />
              <NumberInput
                label={t('Soak (min)')}
                value={editing.cycleSoak?.min_soak_min ?? 15}
                disabled={!editing.cycleSoak}
                onChange={(v) =>
                  setEditing({
                    ...editing,
                    cycleSoak: editing.cycleSoak ? { ...editing.cycleSoak, min_soak_min: Number(v) || 15 } : null,
                  })
                }
              />
            </Group>
            <Group justify="space-between">
              <HintTitle title={t('Own schedules')} hint={t('waters this zone alone, in addition to its group')} />
              <Button size="xs" variant="light" onClick={() => setEditing({ ...editing, schedules: [...(editing.schedules ?? []), emptySchedule()] })}>
                {t('Add schedule')}
              </Button>
            </Group>
            {(editing.schedules ?? []).map((sch, i) => (
              <ScheduleEditor
                key={sch.id}
                schedule={sch}
                busy={busy}
                worstFactor={worstFactor}
                zones={[{ id: editing.id ?? 'new', name: editing.name ?? '', baseMin: editing.baseDurationMin ?? 15, maxRuntimeMin: editing.maxRuntimeMin ?? 60 }]}
                onChange={(ns) => {
                  const next = [...(editing.schedules ?? [])];
                  next[i] = ns;
                  setEditing({ ...editing, schedules: next });
                }}
                onDelete={() => setEditing({ ...editing, schedules: (editing.schedules ?? []).filter((_, j) => j !== i) })}
              />
            ))}
            <Switch
              label={<HintLabel label={t('Allow automatic watering')} hint={t('When off, schedules / soil / heat skip this zone. Manual "Water now" still works. Also exposed to Home Assistant as a switch for automations (e.g. turn off after heavy rain).')} />}
              checked={editing.autoAllow !== false}
              onChange={(e) => setEditing({ ...editing, autoAllow: e.currentTarget.checked })}
            />
            <EntitySelect
              label={<HintLabel label={t('Extra auto-allow entity (optional)')} hint={t('If set, this HA switch / input_boolean / binary_sensor must also be ON for automatic runs. Unavailable = allow.')} />}
              value={editing.autoAllowEntity ?? null}
              onChange={(v) => setEditing({ ...editing, autoAllowEntity: v })}
              domains={['input_boolean', 'switch', 'binary_sensor']}
            />
            <Group>
              <Switch
                label={t('Ignore rain sensor')}
                checked={!!editing.ignore?.rain_sensor}
                onChange={(e) => setEditing({ ...editing, ignore: { ...editing.ignore, rain_sensor: e.currentTarget.checked } })}
              />
              <Switch
                label={t('Ignore weather')}
                checked={!!editing.ignore?.weather}
                onChange={(e) => setEditing({ ...editing, ignore: { ...editing.ignore, weather: e.currentTarget.checked } })}
              />
              <Switch
                label={t('Enabled')}
                checked={editing.enabled !== false}
                onChange={(e) => setEditing({ ...editing, enabled: e.currentTarget.checked })}
              />
            </Group>
            <Button onClick={save}>{t('Save')}</Button>
          </Stack>
        )}
      </Modal>

      <Modal opened={!!runZone} onClose={() => setRunZone(null)} title={t('Water "{name}"', { name: runZone?.name ?? '' })}>
        <Stack>
          <SliderInput label={t('Duration')} value={runMinutes} onChange={setRunMinutes} min={1} max={runZone?.maxRuntimeMin ?? 120} />
          <Text size="xs" c="dimmed">
            {t('Manual runs ignore rain / weather / pause. If any zone is already watering (manual or scheduled), this one waits in the sequential queue until it finishes.')}
          </Text>
          <Button onClick={startRun}>{t('Start / queue')}</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
