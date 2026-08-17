import { useEffect, useState } from 'react';
import { Button, Group, Modal, NumberInput, Select, Stack, Switch, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, Settings, WaterSource, Zone } from '../api';
import { t } from '../i18n';
import { EntityMultiSelect, EntitySelect, SliderInput } from './common';
import { HintLabel, HintTitle } from './Hint';
import ScheduleEditor, { emptySchedule } from './ScheduleEditor';
import { BusyBand, overlapsConflict, toMin } from './TimeSlotPicker';
import { useResource } from '../hooks';
import { DEFAULT_FLOW_LPM, DEFAULT_FLOW_RANGE_LPM, displayFlow, flowSuffix, toStoredL, VolumeUnit } from '../units';

export default function ZoneEditorModal({
  zone,
  sources,
  onClose,
  onSaved,
}: {
  zone: Partial<Zone> | null;
  sources: WaterSource[] | null | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: settings } = useResource<Settings>('/settings');
  const [editing, setEditing] = useState<Partial<Zone> | null>(null);
  const [flowMode, setFlowMode] = useState<'none' | 'value' | 'range'>('none');
  const [busy, setBusy] = useState<BusyBand[]>([]);

  const volUnit: VolumeUnit = settings?.volumeUnit === 'gal' ? 'gal' : 'L';
  const flowUnit = flowSuffix(volUnit);

  useEffect(() => {
    if (!zone) {
      setEditing(null);
      return;
    }
    setEditing({ ...zone, schedules: (zone.schedules ?? []).map((s) => ({ ...s })), ignore: { ...zone.ignore } });
    setFlowMode(zone.flowLpm == null ? 'none' : typeof zone.flowLpm === 'number' ? 'value' : 'range');
    setBusy([]);
    const q = zone.id ? `?excludeKind=zone&excludeId=${zone.id}` : '';
    api
      .get<{ bands: BusyBand[] }>(`/busy-week${q}`)
      .then((r) => setBusy(r.bands))
      .catch(() => setBusy([]));
  }, [zone]);

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
      onSaved();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  return (
    <Modal opened={!!zone} onClose={onClose} title={zone?.id ? t('Edit zone') : t('New zone')} size="lg">
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
                      max: typeof editing.flowLpm === 'object' && editing.flowLpm ? editing.flowLpm.max : DEFAULT_FLOW_RANGE_LPM.max,
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
                      min: typeof editing.flowLpm === 'object' && editing.flowLpm ? editing.flowLpm.min : DEFAULT_FLOW_RANGE_LPM.min,
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
            label={
              <HintLabel
                label={t('Allow automatic watering')}
                hint={t('When off, schedules / soil / heat skip this zone. Manual "Water now" still works. Also exposed to Home Assistant as a switch for automations (e.g. turn off after heavy rain).')}
              />
            }
            checked={editing.autoAllow !== false}
            onChange={(e) => setEditing({ ...editing, autoAllow: e.currentTarget.checked })}
          />
          <EntitySelect
            label={
              <HintLabel
                label={t('Extra auto-allow entity (optional)')}
                hint={t('If set, this HA switch / input_boolean / binary_sensor must also be ON for automatic runs. Unavailable = allow.')}
              />
            }
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
  );
}
