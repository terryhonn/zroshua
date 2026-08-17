import { useEffect, useState } from 'react';
import { Button, Group, Modal, MultiSelect, NumberInput, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, Group as ZGroup, Settings, Zone } from '../api';
import { t } from '../i18n';
import { SliderInput } from './common';
import { HintLabel } from './Hint';
import ScheduleEditor, { emptySchedule, estimateRunMinutes, ZoneInfo } from './ScheduleEditor';
import { BusyBand, overlapsConflict, toMin } from './TimeSlotPicker';
import { useResource } from '../hooks';

export default function GroupEditorModal({
  group,
  zones,
  hideDisabled = false,
  onClose,
  onSaved,
}: {
  group: Partial<ZGroup> | null;
  zones: Zone[] | null | undefined;
  hideDisabled?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: settings } = useResource<Settings>('/settings');
  const [editing, setEditing] = useState<Partial<ZGroup> | null>(null);
  const [busy, setBusy] = useState<BusyBand[]>([]);

  useEffect(() => {
    if (!group) {
      setEditing(null);
      return;
    }
    setEditing({ ...group, schedules: (group.schedules ?? []).map((s) => ({ ...s })) });
    setBusy([]);
    const q = group.id ? `?excludeKind=group&excludeId=${group.id}` : '';
    api
      .get<{ bands: BusyBand[] }>(`/busy-week${q}`)
      .then((r) => setBusy(r.bands))
      .catch(() => setBusy([]));
  }, [group]);

  const worstFactor = settings?.tempScale.enabled
    ? 1 + settings.tempScale.steps.reduce((acc, st) => acc + Math.max(0, st.pct ?? 0), 0) / 100
    : 1;
  const zoneInfoFor = (ids: string[]): ZoneInfo[] =>
    ids
      .map((id) => zones?.find((z) => z.id === id))
      .filter((z): z is Zone => !!z && z.enabled)
      .map((z) => ({ id: z.id, name: z.name, baseMin: z.baseDurationMin, maxRuntimeMin: z.maxRuntimeMin }));

  const conflictSummary = (g: Partial<ZGroup>): string[] => {
    const zi = zoneInfoFor(g.zoneIds ?? []);
    const out: string[] = [];
    for (const sch of (g.schedules ?? []).filter((x) => x.enabled)) {
      const dur = Math.max(
        1,
        estimateRunMinutes(sch, zi, g.mode ?? 'sequential', g.parallelLimit ?? 2, g.interZoneDelayS ?? 0, g.multiplierPct ?? 100) *
          worstFactor,
      );
      const entries: { dows: number[]; start: string }[] =
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
      const conflicts = conflictSummary(editing);
      if (editing.id) await api.put(`/groups/${editing.id}`, editing);
      else await api.post('/groups', editing);
      if (conflicts.length)
        notifications.show({
          title: t('Saved with rule conflicts'),
          message: t('{conflicts} — resolve on the Timeline page or rely on the conflict policy.', { conflicts: conflicts.join('; ') }),
          color: 'red',
          autoClose: 10000,
        });
      onSaved();
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  return (
    <Modal opened={!!group} onClose={onClose} title={group?.id ? t('Edit group') : t('New group')} size="xl">
      {editing && (
        <Stack>
          <TextInput label={t('Name')} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          <MultiSelect
            label={<HintLabel label={t('Zones')} hint={t('order = watering order')} />}
            data={(zones ?? []).map((z) => ({ value: z.id, label: z.name }))}
            value={editing.zoneIds ?? []}
            onChange={(v) => setEditing({ ...editing, zoneIds: v })}
          />
          <Group grow>
            <Select
              label={t('Execution mode')}
              data={[
                { value: 'sequential', label: t('Sequential (one at a time)') },
                { value: 'parallel', label: t('Parallel (all together)') },
                { value: 'parallel_limit', label: t('Parallel with limit') },
              ]}
              value={editing.mode ?? 'sequential'}
              onChange={(v) => setEditing({ ...editing, mode: (v as any) ?? 'sequential' })}
            />
            {editing.mode === 'parallel_limit' && (
              <NumberInput
                label={t('Max zones at once')}
                value={editing.parallelLimit ?? 2}
                onChange={(v) => setEditing({ ...editing, parallelLimit: Number(v) || 2 })}
                min={1}
              />
            )}
            <NumberInput
              label={t('Delay between zones (s)')}
              value={editing.interZoneDelayS ?? 0}
              onChange={(v) => setEditing({ ...editing, interZoneDelayS: Number(v) || 0 })}
            />
            <NumberInput label={t('Priority')} value={editing.priority ?? 0} onChange={(v) => setEditing({ ...editing, priority: Number(v) || 0 })} />
          </Group>
          <SliderInput label={t('Group multiplier')} value={editing.multiplierPct ?? 100} onChange={(v) => setEditing({ ...editing, multiplierPct: v })} min={0} max={200} unit="%" />

          <Group justify="space-between">
            <Text fw={600}>{t('Schedules')}</Text>
            <Button size="xs" variant="light" onClick={() => setEditing({ ...editing, schedules: [...(editing.schedules ?? []), emptySchedule()] })}>
              {t('Add schedule')}
            </Button>
          </Group>
          {(editing.schedules ?? [])
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => !hideDisabled || s.enabled)
            .map(({ s, i }) => (
              <ScheduleEditor
                key={s.id}
                schedule={s}
                zones={zoneInfoFor(editing.zoneIds ?? [])}
                mode={editing.mode ?? 'sequential'}
                parallelLimit={editing.parallelLimit ?? 2}
                interZoneDelayS={editing.interZoneDelayS ?? 0}
                multiplierPct={editing.multiplierPct ?? 100}
                worstFactor={worstFactor}
                busy={busy}
                onChange={(ns) => {
                  const next = [...(editing.schedules ?? [])];
                  next[i] = ns;
                  setEditing({ ...editing, schedules: next });
                }}
                onDelete={() => setEditing({ ...editing, schedules: (editing.schedules ?? []).filter((_, j) => j !== i) })}
              />
            ))}

          <Switch label={t('Enabled')} checked={editing.enabled !== false} onChange={(e) => setEditing({ ...editing, enabled: e.currentTarget.checked })} />
          <Button onClick={save}>{t('Save')}</Button>
        </Stack>
      )}
    </Modal>
  );
}
