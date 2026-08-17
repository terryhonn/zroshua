import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  Title,
  ActionIcon,
} from '@mantine/core';
import { IconDroplet, IconEdit, IconPlayerStop, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api, EngineState, Settings, WaterSource, Zone } from '../api';
import { useResource, fmtDur, fmtAgo } from '../hooks';
import { t } from '../i18n';
import { SliderInput, PauseControl } from '../components/common';
import ZoneEditorModal from '../components/ZoneEditorModal';
import { displayFlow, flowSuffix, VolumeUnit } from '../units';

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

  const volUnit: VolumeUnit = settings?.volumeUnit === 'gal' ? 'gal' : 'L';
  const flowUnit = flowSuffix(volUnit);

  const running = new Set(state?.active.map((a) => a.zoneId));
  const faults = new Set(state?.faults ?? []);

  const fmtFlow = (f: number | { min: number; max: number }) =>
    typeof f === 'number'
      ? String(displayFlow(f, volUnit))
      : `${displayFlow(f.min, volUnit)}–${displayFlow(f.max, volUnit)}`;

  const notifyErr = (e: any) => notifications.show({ message: e.message, color: 'red' });

  const openEdit = (z: Partial<Zone>) => setEditing({ ...z });

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

      <ZoneEditorModal
        zone={editing}
        sources={sources}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />

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
