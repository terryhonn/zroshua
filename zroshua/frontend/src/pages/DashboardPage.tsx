import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Button,
  Card,
  Flex,
  Grid,
  Group,
  Modal,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
  Badge,
  SimpleGrid,
  ActionIcon,
  Tooltip,
  Menu,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconPlayerStop,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconDroplet,
  IconPlant2,
  IconCategory,
  IconBucketDroplet,
  IconClockHour4,
  IconCalendarClock,
  IconTrash,
  IconListNumbers,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api, EngineState, Group as ZGroup, Settings, Upcoming, WaterSource, WeatherNow, Zone } from '../api';
import { fmtDur, fmtTime, useJournal, useResource } from '../hooks';
import { t, locale } from '../i18n';
import { SliderInput } from '../components/common';
import GroupEditorModal from '../components/GroupEditorModal';
import ZoneEditorModal from '../components/ZoneEditorModal';
import { formatTemp, formatVolume, TempUnit, VolumeUnit } from '../units';

const JOURNAL_KIND_COLORS: Record<string, string> = {
  run_start: 'teal',
  run_end: 'blue',
  skip: 'yellow',
  fault: 'red',
  info: 'gray',
  adjust: 'grape',
};

const JOURNAL_KIND_LABELS: Record<string, string> = {
  run_start: 'Run started',
  run_end: 'Run ended',
  skip: 'Skipped',
  fault: 'Fault',
  info: 'Info',
  adjust: 'Adjustment',
};

/** Dashboard top tiles — order is user-draggable and persisted. */
type TileId = 'watering_now' | 'zones' | 'groups' | 'today_water' | 'today_time' | 'next_watering';
type TodayTimeFormat = 'min' | 'hm';

const DEFAULT_TILE_ORDER: TileId[] = [
  'watering_now',
  'zones',
  'groups',
  'today_water',
  'today_time',
  'next_watering',
];
const TILE_ORDER_KEY = 'zroshua.dashboardTileOrder';
const TODAY_TIME_FMT_KEY = 'zroshua.dashboardTodayTimeFormat';

function loadTileOrder(): TileId[] {
  try {
    const raw = localStorage.getItem(TILE_ORDER_KEY);
    if (!raw) return [...DEFAULT_TILE_ORDER];
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) return [...DEFAULT_TILE_ORDER];
    const known = new Set<string>(DEFAULT_TILE_ORDER);
    const order = parsed.filter((id): id is TileId => known.has(id));
    for (const id of DEFAULT_TILE_ORDER) if (!order.includes(id)) order.push(id);
    return order;
  } catch {
    return [...DEFAULT_TILE_ORDER];
  }
}

function saveTileOrder(order: TileId[]) {
  try {
    localStorage.setItem(TILE_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* private mode */
  }
}

function loadTodayTimeFormat(): TodayTimeFormat {
  try {
    return localStorage.getItem(TODAY_TIME_FMT_KEY) === 'hm' ? 'hm' : 'min';
  } catch {
    return 'min';
  }
}

function saveTodayTimeFormat(fmt: TodayTimeFormat) {
  try {
    localStorage.setItem(TODAY_TIME_FMT_KEY, fmt);
  } catch {
    /* private mode */
  }
}

/** Minutes as "142 min" or "2 hrs, 22 min". */
function formatTodayMinutes(minutes: number, fmt: TodayTimeFormat): string {
  const m = Math.max(0, Math.round(minutes));
  if (fmt === 'min') return t('{n} min', { n: m });
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h <= 0) return t('{n} min', { n: rem });
  if (rem === 0) return t('{h} hrs', { h });
  return t('{h} hrs, {m} min', { h, m: rem });
}

function InfoTile({
  label,
  value,
  sub,
  icon,
  color,
  onClick,
  clickable,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  color: string;
  onClick?: () => void;
  clickable?: boolean;
  dragging?: boolean;
  dragOver?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}) {
  return (
    <Card
      p="sm"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        cursor: clickable ? 'pointer' : 'grab',
        opacity: dragging ? 0.45 : 1,
        outline: dragOver ? '2px solid var(--mantine-color-teal-5)' : undefined,
        outlineOffset: 2,
        userSelect: 'none',
        transition: 'opacity 0.12s ease, outline 0.12s ease',
      }}
      title={
        clickable
          ? t('Drag to reorder · Click to toggle format')
          : t('Drag to reorder')
      }
    >
      <Group gap="sm" wrap="nowrap" align="flex-start" style={{ pointerEvents: 'none' }}>
        <ThemeIcon variant="light" color={color} size={40} radius="md">
          {icon}
        </ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {label}
          </Text>
          <Text size="lg" fw={700} lh={1.25} truncate>
            {value}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed" truncate>
              {sub}
            </Text>
          )}
        </div>
      </Group>
    </Card>
  );
}

export default function DashboardPage({ state, journalTick = 0 }: { state: EngineState | null; journalTick?: number }) {
  const { data: weather } = useResource<WeatherNow>('/weather');
  const { data: settings } = useResource<Settings>('/settings');
  const tempUnit: TempUnit = settings?.tempUnit === 'F' ? 'F' : 'C';
  const volUnit: VolumeUnit = settings?.volumeUnit === 'gal' ? 'gal' : 'L';
  const { data: upcoming, reload: reloadUpcoming } = useResource<Upcoming[]>('/upcoming', [state?.active.length]);
  const { data: zones, reload: reloadZones } = useResource<Zone[]>('/zones');
  const { data: groups, reload: reloadGroups } = useResource<ZGroup[]>('/groups');
  const { data: sources } = useResource<WaterSource[]>('/sources');
  const [editGroup, setEditGroup] = useState<Partial<ZGroup> | null>(null);
  const [editZone, setEditZone] = useState<Partial<Zone> | null>(null);
  const journal = useJournal(journalTick);
  const { data: today } = useResource<{
    days: { day: string; minutes: number; litersMin: number; litersMax: number }[];
    totals: { minutes: number; litersMin: number; litersMax: number };
  }>('/stats/daily?days=1', [state?.active.length]);

  const nameOf = (zoneId: string | null, groupId: string | null) => {
    if (zoneId) return zones?.find((z) => z.id === zoneId)?.name ?? zoneId;
    if (groupId) return groups?.find((g) => g.id === groupId)?.name ?? groupId;
    return null;
  };
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const countdown = (ts: number) => {
    const s = Math.max(0, Math.round((ts - nowTick) / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return t('in {d}d {h}h', { d, h });
    if (h > 0) return t('in {h}h {m}m', { h, m: String(m).padStart(2, '0') });
    return t('in {m}m', { m });
  };
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [hours, setHours] = useState(24);
  const [addQueueOpen, setAddQueueOpen] = useState(false);
  const [addZoneId, setAddZoneId] = useState<string | null>(null);
  const [addMinutes, setAddMinutes] = useState(15);
  const [tileOrder, setTileOrder] = useState<TileId[]>(loadTileOrder);
  const [todayTimeFmt, setTodayTimeFmt] = useState<TodayTimeFormat>(loadTodayTimeFormat);
  const [dragId, setDragId] = useState<TileId | null>(null);
  const [overId, setOverId] = useState<TileId | null>(null);
  /** Ignore click after a real drag so reordering does not toggle Today time. */
  const didDrag = useRef(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifications.show({ message: ok, color: 'teal' });
    } catch (e: any) {
      notifications.show({ message: e.message, color: 'red' });
    }
  };

  const openUpcoming = (u: Upcoming) => {
    if (u.kind === 'zone') {
      const z = (zones ?? []).find((z) => z.id === (u.targetId ?? u.zones[0]?.zoneId));
      if (z) setEditZone(z);
      return;
    }
    const g = (groups ?? []).find((g) => g.id === u.groupId);
    if (g) setEditGroup(g);
  };

  /** pause/resume the target (group or single zone) of an upcoming row */
  const pauseRow = (u: Upcoming, hours: number) => {
    const kind = u.kind ?? 'group';
    const id = u.targetId ?? u.groupId;
    const path = kind === 'zone' ? `/zones/${id}/pause` : `/groups/${id}/pause`;
    return act(() => api.post(path, { hours }), hours > 0 ? t('paused') : t('Resume'));
  };

  const next = (upcoming ?? []).filter((u) => u.ts > Date.now()).slice(0, 6);
  // Prefer today's local bucket (backend keys are local YYYY-MM-DD). Totals
  // for days=1 is the same after the calendar-day fix; this stays correct if
  // the window ever spans two keys.
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const todayRow = today?.days?.find((d) => d.day === todayKey) ?? (today ? { ...today.totals, day: todayKey } : null);
  const liveMin = (state?.active ?? []).reduce((acc, a) => acc + Math.max(0, (nowTick - a.startTs) / 60_000), 0);
  const minutesToday = todayRow ? todayRow.minutes + liveMin : null;
  const litersToday = todayRow ? (todayRow.litersMin + todayRow.litersMax) / 2 : null;

  const reorderTiles = (from: TileId, to: TileId) => {
    if (from === to) return;
    setTileOrder((prev) => {
      const nextOrder = [...prev];
      const fi = nextOrder.indexOf(from);
      const ti = nextOrder.indexOf(to);
      if (fi < 0 || ti < 0) return prev;
      nextOrder.splice(fi, 1);
      nextOrder.splice(ti, 0, from);
      saveTileOrder(nextOrder);
      return nextOrder;
    });
  };

  const tileDnD = (id: TileId) => ({
    dragging: dragId === id,
    dragOver: overId === id && dragId !== id,
    onDragStart: (e: DragEvent) => {
      didDrag.current = false;
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      didDrag.current = true;
      if (overId !== id) setOverId(id);
    },
    onDragLeave: () => {
      if (overId === id) setOverId(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = (e.dataTransfer.getData('text/plain') as TileId) || dragId;
      if (from) reorderTiles(from, id);
      setDragId(null);
      setOverId(null);
    },
    onDragEnd: () => {
      setDragId(null);
      setOverId(null);
    },
  });

  const toggleTodayTimeFmt = () => {
    if (didDrag.current) return;
    setTodayTimeFmt((prev) => {
      const nextFmt: TodayTimeFormat = prev === 'min' ? 'hm' : 'min';
      saveTodayTimeFormat(nextFmt);
      return nextFmt;
    });
  };

  const tiles: Record<TileId, ReactNode> = {
    watering_now: (
      <InfoTile
        key="watering_now"
        label={t('Watering now')}
        value={String(state?.active.length ?? 0)}
        sub={state?.queue.length ? t('{n} queued', { n: state.queue.length }) : undefined}
        icon={<IconDroplet size={22} />}
        color="teal"
        {...tileDnD('watering_now')}
      />
    ),
    zones: (
      <InfoTile
        key="zones"
        label={t('Zones')}
        value={`${(zones ?? []).filter((z) => z.enabled).length}/${zones?.length ?? 0}`}
        sub={t('enabled / total')}
        icon={<IconPlant2 size={22} />}
        color="green"
        {...tileDnD('zones')}
      />
    ),
    groups: (
      <InfoTile
        key="groups"
        label={t('Groups')}
        value={String(groups?.length ?? 0)}
        sub={t('{n} enabled', { n: (groups ?? []).filter((g) => g.enabled).length })}
        icon={<IconCategory size={22} />}
        color="violet"
        {...tileDnD('groups')}
      />
    ),
    today_water: (
      <InfoTile
        key="today_water"
        label={t('Today water')}
        value={litersToday !== null ? formatVolume(litersToday, volUnit) : '—'}
        icon={<IconBucketDroplet size={22} />}
        color="blue"
        {...tileDnD('today_water')}
      />
    ),
    today_time: (
      <InfoTile
        key="today_time"
        label={t('Today time')}
        value={minutesToday !== null ? formatTodayMinutes(minutesToday, todayTimeFmt) : '—'}
        sub={todayTimeFmt === 'hm' ? t('hours + minutes') : t('minutes')}
        icon={<IconClockHour4 size={22} />}
        color="orange"
        clickable
        onClick={toggleTodayTimeFmt}
        {...tileDnD('today_time')}
      />
    ),
    next_watering: (
      <InfoTile
        key="next_watering"
        label={t('Next watering')}
        value={next[0] ? countdown(next[0].ts) : '—'}
        sub={
          next[0]
            ? `${new Date(next[0].ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} · ${next[0].groupName}`
            : undefined
        }
        icon={<IconCalendarClock size={22} />}
        color="grape"
        {...tileDnD('next_watering')}
      />
    ),
  };

  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, xs: 3, md: 6 }}>
        {tileOrder.map((id) => tiles[id])}
      </SimpleGrid>
      <Grid>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="md">
            <Card withBorder>
              <Title order={4} mb="sm">
                {t('Now')}
              </Title>
              {state?.active.length ? (
                <Stack gap="sm">
                  {state.active.map((a) => (
                    <div key={a.zoneId}>
                      <Group justify="space-between" mb={4}>
                        <Group gap="xs">
                          <Text fw={600}>{a.zoneName}</Text>
                          <Badge size="xs" variant="light">
                            {t(a.triggeredBy)}
                          </Badge>
                        </Group>
                        <Group gap="xs">
                          <Text size="sm" c="dimmed">
                            {t('ends {time}', { time: fmtTime(a.endsAt) })}
                          </Text>
                          <ActionIcon
                            variant="light"
                            onClick={() => act(() => api.post(`/zones/${a.zoneId}/extend`, { minutes: 5 }), t('+5 min'))}
                            title={t('+5 min')}
                          >
                            <IconPlus size={16} />
                          </ActionIcon>
                          <ActionIcon
                            color="red"
                            variant="light"
                            onClick={() => act(() => api.post(`/zones/${a.zoneId}/stop`), t('Stopped'))}
                            title={t('Stop')}
                          >
                            <IconPlayerStop size={16} />
                          </ActionIcon>
                        </Group>
                      </Group>
                      <Progress value={a.progress * 100} animated />
                    </div>
                  ))}
                </Stack>
              ) : (
                <Text c="dimmed">{t('Nothing is watering right now.')}</Text>
              )}

              {state?.queue.length ? (
                <>
                  <Title order={5} mt="md" mb="xs">
                    {t('Queue')}
                  </Title>
                  <Stack gap={4}>
                    {state.queue.map((q, i) => (
                      <Group key={i} justify="space-between">
                        <Text size="sm">
                          {q.zoneName} — {fmtDur(q.durationMin)}
                        </Text>
                        <Badge variant="light" color="gray">
                          {q.waitReason}
                        </Badge>
                      </Group>
                    ))}
                  </Stack>
                </>
              ) : null}
            </Card>

            <Card withBorder>
              <Title order={4} mb="sm">
                {t('Upcoming waterings')}
              </Title>
              {next.length ? (
                <Stack gap="xs">
                  {next.map((u, i) => {
                    const paused = u.snoozeUntil != null && u.snoozeUntil > Date.now();
                    const dim = u.willSkip || paused ? 0.55 : 1;
                    return (
                      <Flex
                        key={i}
                        direction={{ base: 'column', sm: 'row' }}
                        align={{ base: 'stretch', sm: 'center' }}
                        justify="space-between"
                        gap={{ base: 4, sm: 'sm' }}
                        className="z-upcoming-row"
                        onClick={() => openUpcoming(u)}
                        title={u.kind === 'zone' ? t('Edit zone') : t('Edit group')}
                        style={{
                          borderBottom:
                            i < next.length - 1 ? '1px solid var(--mantine-color-default-border)' : undefined,
                          paddingBottom: 6,
                        }}
                      >
                        <Text style={{ opacity: dim, minWidth: 0 }} truncate>
                          <b>{u.groupName}</b>
                          {u.kind === 'zone' ? '' : u.zones.length ? ` — ${u.zones.map((z) => z.name).join(', ')}` : ''}
                          {u.kind === 'zone' && (
                            <Badge size="xs" variant="light" color="blue" ml={6} style={{ verticalAlign: 'middle' }}>
                              {t('zone')}
                            </Badge>
                          )}
                        </Text>
                        <Group gap="xs" wrap="wrap" justify="flex-end" style={{ flexShrink: 0 }}>
                          {paused && (
                            <Badge variant="light" color="gray" leftSection={<IconPlayerPause size={12} />}>
                              {t('paused')}
                            </Badge>
                          )}
                          {!paused && u.willSkip && (
                            <Tooltip label={(u.skipReasons ?? []).join('; ')} multiline maw={320}>
                              <Badge variant="light" color="red" leftSection={<IconAlertTriangle size={12} />}>
                                {t('will skip')}
                              </Badge>
                            </Tooltip>
                          )}
                          {!paused && !u.willSkip && (u.maybeSkip?.length ?? 0) > 0 && (
                            <Tooltip label={(u.maybeSkip ?? []).join('; ')} multiline maw={320}>
                              <Badge variant="light" color="yellow" leftSection={<IconAlertTriangle size={12} />}>
                                {t('may skip')}
                              </Badge>
                            </Tooltip>
                          )}
                          <Text size="sm" c="dimmed">
                            {u.zones.length
                              ? t('{dur} (max {max})', {
                                  dur: fmtDur(u.durationMin ?? u.zones.reduce((a, z) => a + z.minutes, 0)),
                                  max: fmtDur(u.maxDurationMin ?? u.zones.reduce((a, z) => a + z.maxMinutes, 0)),
                                })
                              : ''}
                          </Text>
                          <Badge variant="light" color="grape" style={{ opacity: dim }}>
                            {countdown(u.ts)}
                          </Badge>
                          <Badge variant="light" style={{ opacity: dim }}>
                            {fmtTime(u.ts)}
                          </Badge>
                          <Menu position="bottom-end" withArrow>
                            <Menu.Target>
                              <ActionIcon
                                variant="subtle"
                                color={paused ? 'teal' : 'gray'}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>
                                {u.kind === 'zone' ? t('{name} · zone', { name: u.groupName }) : u.groupName}
                              </Menu.Label>
                              {paused ? (
                                <Menu.Item leftSection={<IconPlayerPlay size={14} />} onClick={() => pauseRow(u, 0)}>
                                  {t('Resume')}
                                </Menu.Item>
                              ) : (
                                <>
                                  <Menu.Item
                                    leftSection={<IconPlayerPause size={14} />}
                                    onClick={() =>
                                      pauseRow(u, Math.max(0.05, (u.ts + 60_000 - Date.now()) / 3600_000))
                                    }
                                  >
                                    {t('Skip this run')}
                                  </Menu.Item>
                                  <Menu.Item onClick={() => pauseRow(u, 6)}>{t('Pause {n} h', { n: 6 })}</Menu.Item>
                                  <Menu.Item onClick={() => pauseRow(u, 12)}>{t('Pause {n} h', { n: 12 })}</Menu.Item>
                                  <Menu.Item onClick={() => pauseRow(u, 24)}>{t('Pause {n} h', { n: 24 })}</Menu.Item>
                                </>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        </Group>
                      </Flex>
                    );
                  })}
                </Stack>
              ) : (
                <Text c="dimmed">{t('No scheduled waterings in the next 7 days.')}</Text>
              )}
            </Card>

            <Card withBorder>
              <Title order={4} mb="sm">
                {t('Journal')}
              </Title>
              {journal.length ? (
                <ScrollArea h={320} type="auto" offsetScrollbars>
                  <Stack gap={6} pr="xs">
                    {journal.map((e) => {
                      const target = nameOf(e.zoneId, e.groupId);
                      return (
                        <Group
                          key={e.id}
                          justify="space-between"
                          align="flex-start"
                          wrap="nowrap"
                          gap="sm"
                          style={{
                            borderBottom: '1px solid var(--mantine-color-default-border)',
                            paddingBottom: 6,
                          }}
                        >
                          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap={6} wrap="wrap">
                              <Badge size="sm" variant="light" color={JOURNAL_KIND_COLORS[e.kind] ?? 'gray'}>
                                {t(JOURNAL_KIND_LABELS[e.kind] ?? e.kind)}
                                {e.code ? `: ${e.code}` : ''}
                              </Badge>
                              {target && (
                                <Text size="sm" fw={500} truncate>
                                  {target}
                                </Text>
                              )}
                            </Group>
                            {e.detail && (
                              <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                                {e.detail}
                              </Text>
                            )}
                          </Stack>
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                            {new Date(Number(e.ts)).toLocaleString(locale)}
                          </Text>
                        </Group>
                      );
                    })}
                  </Stack>
                </ScrollArea>
              ) : (
                <Text c="dimmed">{t('No journal entries yet.')}</Text>
              )}
            </Card>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap="md">
            <Card withBorder>
              <Title order={4} mb="sm">
                {t('Weather')}
              </Title>
              {weather?.entity ? (
                <>
                  <Group>
                    <Text size="xl" fw={700}>
                      {formatTemp(weather.temperature, tempUnit)}
                    </Text>
                    <Text c="dimmed">{weather.condition ? t(weather.condition) : ''}</Text>
                    {weather.humidity != null && <Text c="dimmed">💧 {weather.humidity}%</Text>}
                  </Group>
                  <SimpleGrid cols={{ base: 4, sm: 7 }} mt="sm">
                    {weather.forecast.slice(0, 7).map((f, i) => (
                      <Stack key={i} gap={0} align="center">
                        <Text size="xs" c="dimmed">
                          {new Date(Date.now() + i * 86400000).toLocaleDateString(locale, { weekday: 'short' })}
                        </Text>
                        <Text size="sm" fw={600}>
                          {formatTemp(f.tempMaxC, tempUnit)}
                        </Text>
                        <Text size="xs" c="blue">
                          {f.precipitationProbability != null ? `${f.precipitationProbability}%` : ''}
                        </Text>
                      </Stack>
                    ))}
                  </SimpleGrid>
                </>
              ) : (
                <Text c="dimmed">{t('No weather entity found in Home Assistant.')}</Text>
              )}
            </Card>

            <Card withBorder>
              <Title order={4} mb="sm">
                {t('Quick actions')}
              </Title>
              <Group>
                <Button
                  color="red"
                  leftSection={<IconPlayerStop size={16} />}
                  onClick={() => act(() => api.post('/stop-all'), t('All stopped'))}
                >
                  {t('Stop all')}
                </Button>
                <Button variant="light" leftSection={<IconPlayerPause size={16} />} onClick={() => setSnoozeOpen(true)}>
                  {state?.snoozeUntil ? `${t('paused')} · ${fmtTime(state.snoozeUntil)}` : t('Pause all')}
                </Button>
              </Group>
              {state?.pumpStates.length ? (
                <Group mt="sm" gap="xs">
                  {state.pumpStates.map((p) => (
                    <Badge key={p.sourceId} color={p.on ? 'teal' : 'gray'} variant="light">
                      {p.on ? t('pump {name}: ON', { name: p.name }) : t('pump {name}: off', { name: p.name })}
                    </Badge>
                  ))}
                </Group>
              ) : null}
              {(state?.sourceLevels?.length ?? 0) > 0 && (
                <Stack gap={6} mt="sm">
                  {state!.sourceLevels!.map((l) => (
                    <div key={l.sourceId}>
                      <Group justify="space-between" mb={2}>
                        <Text size="xs" c="dimmed">
                          {l.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {l.levelL !== null
                            ? t('~{vol} ({pct}%)', { vol: formatVolume(l.levelL, volUnit), pct: String(l.levelPct) })
                            : '—'}
                        </Text>
                      </Group>
                      <Progress
                        value={l.levelPct ?? 0}
                        color={(l.levelPct ?? 100) < 20 ? 'red' : (l.levelPct ?? 100) < 40 ? 'yellow' : 'blue'}
                        size="sm"
                      />
                    </div>
                  ))}
                </Stack>
              )}
            </Card>

            <Card withBorder>
              <Group justify="space-between" mb="sm" wrap="wrap">
                <Title order={4}>{t('Manual queue')}</Title>
                <Group gap="xs">
                  {(state?.manualQueue?.length ?? 0) > 0 && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => act(() => api.post('/manual-queue/clear'), t('Manual queue cleared'))}
                    >
                      {t('Clear queue')}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => {
                      const first = (zones ?? []).find((z) => z.enabled);
                      setAddZoneId(first?.id ?? null);
                      setAddMinutes(Math.round(first?.baseDurationMin ?? 15));
                      setAddQueueOpen(true);
                    }}
                  >
                    {t('Add zone')}
                  </Button>
                </Group>
              </Group>
              <Text size="xs" c="dimmed" mb="sm">
                {t('Start a zone manually, then queue more to run one after another. A queued zone waits until whatever is currently watering (manual or scheduled) finishes. Adjust duration for this run only.')}
              </Text>
              {(() => {
                const waiting = state?.manualQueue ?? [];
                // While something is waiting, show every active zone as the head
                // of the line (including a scheduled run the queue is yielding to).
                const runningHead = waiting.length
                  ? (state?.active ?? [])
                  : (state?.active ?? []).filter((a) => a.manual);
                if (!runningHead.length && !waiting.length) {
                  return <Text size="sm" c="dimmed">{t('No manual runs queued. Use Add zone or Water now on a zone.')}</Text>;
                }
                return (
                  <Stack gap="xs">
                    {runningHead.map((a) => (
                      <Group key={`run-${a.zoneId}`} justify="space-between" wrap="nowrap" gap="xs">
                        <Group gap="xs" style={{ minWidth: 0 }}>
                          <Badge size="sm" color="teal" variant="light" leftSection={<IconDroplet size={12} />}>
                            {a.manual ? t('running') : t('scheduled')}
                          </Badge>
                          <Text size="sm" fw={600} truncate>
                            {a.zoneName}
                          </Text>
                        </Group>
                        <Group gap={4} wrap="nowrap">
                          <Text size="xs" c="dimmed">
                            {fmtDur(a.plannedMin)} · {t('ends {time}', { time: fmtTime(a.endsAt) })}
                          </Text>
                          <ActionIcon
                            size="sm"
                            color="red"
                            variant="light"
                            title={t('Stop')}
                            onClick={() => act(() => api.post(`/zones/${a.zoneId}/stop`), t('Stopped'))}
                          >
                            <IconPlayerStop size={14} />
                          </ActionIcon>
                        </Group>
                      </Group>
                    ))}
                    {waiting.map((q) => (
                      <Group key={q.key} justify="space-between" wrap="nowrap" gap="xs">
                        <Group gap="xs" style={{ minWidth: 0 }}>
                          <Badge size="sm" color="gray" variant="light" leftSection={<IconListNumbers size={12} />}>
                            #{q.position}
                          </Badge>
                          <Text size="sm" truncate>
                            {q.zoneName}
                          </Text>
                        </Group>
                        <Group gap={4} wrap="nowrap">
                          <Text size="xs" c="dimmed">
                            {fmtDur(q.durationMin)}
                            {q.waitReason ? ` · ${q.waitReason}` : ''}
                          </Text>
                          <ActionIcon
                            size="sm"
                            color="red"
                            variant="subtle"
                            title={t('Remove from queue')}
                            onClick={() =>
                              act(() => api.post('/manual-queue/remove', { key: q.key }), t('Removed from queue'))
                            }
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Group>
                      </Group>
                    ))}
                  </Stack>
                );
              })()}
            </Card>
          </Stack>
        </Grid.Col>
      </Grid>

      <Modal opened={snoozeOpen} onClose={() => setSnoozeOpen(false)} title={t('Pause all watering')}>
        <Stack>
          <Text size="sm" c="dimmed">
            {t('Skip all automatic (scheduled, soil, weather) watering for a while. Manual runs still work.')}
          </Text>
          <SliderInput label={t('Pause for')} value={hours} onChange={setHours} min={0} max={336} step={6} unit="h" />
          <Group>
            <Button onClick={() => act(() => api.post('/snooze', { hours }), t('Paused')).then(() => setSnoozeOpen(false))}>{t('Pause')}</Button>
            <Button variant="light" onClick={() => act(() => api.post('/snooze', { hours: 0 }), t('Resumed')).then(() => setSnoozeOpen(false))}>
              {t('Resume now')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={addQueueOpen} onClose={() => setAddQueueOpen(false)} title={t('Add zone to manual queue')}>
        <Stack>
          <Select
            label={t('Zone')}
            searchable
            data={(zones ?? [])
              .filter((z) => z.enabled)
              .map((z) => ({ value: z.id, label: z.name }))}
            value={addZoneId}
            onChange={(v) => {
              setAddZoneId(v);
              const z = (zones ?? []).find((x) => x.id === v);
              if (z) setAddMinutes(Math.round(z.baseDurationMin));
            }}
          />
          <SliderInput
            label={t('Duration for this run')}
            value={addMinutes}
            onChange={setAddMinutes}
            min={1}
            max={
              Math.max(
                1,
                Math.round((zones ?? []).find((z) => z.id === addZoneId)?.maxRuntimeMin ?? 120),
              )
            }
          />
          <Text size="xs" c="dimmed">
            {t('Default is the zone’s configured duration. If any zone is already watering (manual or scheduled), this one waits until it finishes.')}
          </Text>
          <Button
            disabled={!addZoneId}
            onClick={async () => {
              if (!addZoneId) return;
              try {
                const res = await api.post<{
                  warnings?: string[];
                  queued?: boolean;
                  durationMin?: number;
                }>(`/zones/${addZoneId}/run`, { minutes: addMinutes });
                const zname = (zones ?? []).find((z) => z.id === addZoneId)?.name ?? addZoneId;
                if (res.queued) {
                  notifications.show({
                    message: t('Queued "{name}" for {minutes} min', { name: zname, minutes: addMinutes }),
                    color: 'blue',
                  });
                } else {
                  notifications.show({
                    message: t('Watering "{name}" for {minutes} min', { name: zname, minutes: addMinutes }),
                    color: 'teal',
                  });
                }
                if (res.warnings?.length) {
                  notifications.show({ title: t('Started with warnings'), message: res.warnings.join('; '), color: 'yellow' });
                }
                setAddQueueOpen(false);
              } catch (e: any) {
                notifications.show({ message: e.message, color: 'red' });
              }
            }}
          >
            {t('Add / start')}
          </Button>
        </Stack>
      </Modal>
      <GroupEditorModal
        group={editGroup}
        zones={zones}
        onClose={() => setEditGroup(null)}
        onSaved={() => {
          setEditGroup(null);
          reloadGroups();
          reloadUpcoming();
        }}
      />
      <ZoneEditorModal
        zone={editZone}
        sources={sources}
        onClose={() => setEditZone(null)}
        onSaved={() => {
          setEditZone(null);
          reloadZones();
          reloadUpcoming();
        }}
      />
    </Stack>
  );
}
