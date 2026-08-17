import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconEdit, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api, Group as ZGroup, GroupRule, Zone } from '../api';
import { useResource, fmtAgo } from '../hooks';
import { t } from '../i18n';
import { PauseControl } from '../components/common';
import GroupEditorModal from '../components/GroupEditorModal';

type LastRuns = { zones: Record<string, number>; groups: Record<string, number> };

const HIDE_DISABLED_KEY = 'zroshua.hideDisabledGroups';

export default function GroupsPage() {
  const { data: groups, reload } = useResource<ZGroup[]>('/groups');
  const { data: zones } = useResource<Zone[]>('/zones');
  const { data: rules, reload: reloadRules } = useResource<GroupRule[]>('/rules');
  const { data: lastRuns } = useResource<LastRuns>('/last-runs');
  const [editing, setEditing] = useState<Partial<ZGroup> | null>(null);
  const [ruleType, setRuleType] = useState<'mutex' | 'order' | 'parallel_ok'>('mutex');
  const [ruleGroups, setRuleGroups] = useState<string[]>([]);
  const [ruleBefore, setRuleBefore] = useState<string | null>(null);
  const [ruleAfter, setRuleAfter] = useState<string | null>(null);
  /** When on, hide disabled groups on the list and disabled schedules in the editor. Default off; persisted. */
  const [hideDisabled, setHideDisabled] = useState(() => {
    try {
      return localStorage.getItem(HIDE_DISABLED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setHideDisabledPersist = (on: boolean) => {
    setHideDisabled(on);
    try {
      localStorage.setItem(HIDE_DISABLED_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  };

  const notifyErr = (e: any) => notifications.show({ message: e.message, color: 'red' });
  const groupOpts = (groups ?? []).map((g) => ({ value: g.id, label: g.name }));
  const visibleGroups = (groups ?? []).filter((g) => !hideDisabled || g.enabled);

  const openEditor = (g: Partial<ZGroup>) => setEditing({ ...g });

  const addRule = async () => {
    try {
      const body =
        ruleType === 'order' ? { type: ruleType, before: ruleBefore, after: ruleAfter, groups: [] } : { type: ruleType, groups: ruleGroups };
      await api.post('/rules', body);
      setRuleGroups([]);
      setRuleBefore(null);
      setRuleAfter(null);
      reloadRules();
    } catch (e) {
      notifyErr(e);
    }
  };

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>{t('Groups & schedules')}</Title>
        <Group gap="md">
          <Switch
            label={t('Hide Disabled')}
            checked={hideDisabled}
            onChange={(e) => setHideDisabledPersist(e.currentTarget.checked)}
          />
          <Button onClick={() => openEditor({ name: '', zoneIds: [], mode: 'sequential', parallelLimit: 2, interZoneDelayS: 0, multiplierPct: 100, priority: 0, schedules: [], enabled: true })}>
            {t('Add group')}
          </Button>
        </Group>
      </Group>

      {visibleGroups.map((g) => (
        <Card key={g.id} withBorder>
          <Group justify="space-between">
            <Group gap="xs">
              <Text fw={600}>{g.name}</Text>
              <Badge variant="light">{g.mode}</Badge>
              {!g.enabled && <Badge color="gray">{t('disabled')}</Badge>}
              {!!g.snoozeUntil && g.snoozeUntil > Date.now() && (
                <Badge color="orange" variant="light">
                  {t('paused')}
                </Badge>
              )}
              <Badge variant="light" color="grape">
                ×{g.multiplierPct}%
              </Badge>
            </Group>
            <Group gap={4}>
              <ActionIcon
                variant="light"
                color="teal"
                title={t('Run group now')}
                onClick={() =>
                  api
                    .post(`/groups/${g.id}/run`)
                    .then(() => notifications.show({ message: t('Group "{name}" started', { name: g.name }), color: 'teal' }))
                    .catch(notifyErr)
                }
              >
                <IconPlayerPlay size={18} />
              </ActionIcon>
              <PauseControl path={`/groups/${g.id}`} pausedUntil={g.snoozeUntil} onChange={reload} />
              <ActionIcon variant="subtle" onClick={() => openEditor(g)}>
                <IconEdit size={18} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="red" onClick={() => api.del(`/groups/${g.id}`).then(reload).catch(notifyErr)}>
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
          </Group>
          <Text size="sm" c="dimmed">
            {g.zoneIds.map((id) => zones?.find((z) => z.id === id)?.name ?? id).join(' → ') || t('no zones')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('{count} active schedules', { count: g.schedules.filter((s) => s.enabled).length })} ·{' '}
            {t('last watered:')} {fmtAgo(lastRuns?.groups[g.id])}
          </Text>
        </Card>
      ))}

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('Rules between groups')}
        </Title>
        <Table>
          <Table.Tbody>
            {(rules ?? []).map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>
                  {r.type === 'order' ? (
                    <Text size="sm">
                      <Badge variant="light" color="orange" mr={6}>
                        {t('order')}
                      </Badge>
                      {groupOpts.find((g) => g.value === r.before)?.label ?? r.before} <b>{t('before')}</b>{' '}
                      {groupOpts.find((g) => g.value === r.after)?.label ?? r.after}
                    </Text>
                  ) : (
                    <Text size="sm">
                      <Badge variant="light" color={r.type === 'mutex' ? 'red' : 'teal'} mr={6}>
                        {r.type === 'mutex' ? t('never overlap') : t('may run in parallel')}
                      </Badge>
                      {r.groups.map((id) => groupOpts.find((g) => g.value === id)?.label ?? id).join(' + ')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td w={40}>
                  <ActionIcon variant="subtle" color="red" onClick={() => api.del(`/rules/${r.id}`).then(reloadRules).catch(notifyErr)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group mt="sm" align="end">
          <Select
            label={t('Rule')}
            w={180}
            data={[
              { value: 'mutex', label: t('Never overlap') },
              { value: 'order', label: t('Order (A before B)') },
              { value: 'parallel_ok', label: t('May run in parallel') },
            ]}
            value={ruleType}
            onChange={(v) => setRuleType((v as any) ?? 'mutex')}
          />
          {ruleType === 'order' ? (
            <>
              <Select label={t('First (A)')} data={groupOpts} value={ruleBefore} onChange={setRuleBefore} w={180} />
              <Select label={t('Then (B)')} data={groupOpts} value={ruleAfter} onChange={setRuleAfter} w={180} />
            </>
          ) : (
            <MultiSelect label={t('Groups')} data={groupOpts} value={ruleGroups} onChange={setRuleGroups} w={280} />
          )}
          <Button onClick={addRule}>{t('Add rule')}</Button>
        </Group>
      </Card>

      <GroupEditorModal
        group={editing}
        zones={zones}
        hideDisabled={hideDisabled}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </Stack>
  );
}
