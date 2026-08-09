import { useState } from 'react';
import { BarChart } from '@mantine/charts';
import { Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { Settings } from '../api';
import { useResource } from '../hooks';
import { t } from '../i18n';
import { displayVolume, formatVolumeRange, VolumeUnit, volumeSuffix } from '../units';

interface Daily {
  days: { day: string; minutes: number; litersMin: number; litersMax: number; energyKwh: number; tailKwh: number }[];
  totals: { minutes: number; litersMin: number; litersMax: number; energyKwh: number; tailKwh: number };
  tariff: number | null;
  currency: string | null;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card withBorder>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700}>
        {value}
      </Text>
    </Card>
  );
}

export default function StatsPage() {
  const [days, setDays] = useState('30');
  const { data } = useResource<Daily>(`/stats/daily?days=${days}`, [days]);
  const { data: settings } = useResource<Settings>('/settings');
  const volUnit: VolumeUnit = settings?.volumeUnit === 'gal' ? 'gal' : 'L';
  const volLabel = volUnit === 'gal' ? t('gallons') : t('liters');

  const chartData = (data?.days ?? []).map((d) => ({
    day: d.day.slice(5),
    volume: displayVolume((d.litersMin + d.litersMax) / 2, volUnit),
    minutes: Math.round(d.minutes),
    kWh: Number((d.energyKwh + d.tailKwh).toFixed(2)),
  }));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>{t('Statistics')}</Title>
        <Group>
          <SegmentedControl
            data={[
              { value: '7', label: t('Week') },
              { value: '30', label: t('Month') },
              { value: '90', label: t('Season') },
            ]}
            value={days}
            onChange={setDays}
          />
          <Button component="a" href={`./api/stats/export.csv?days=${days}`} variant="light">
            {t('Export CSV')}
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <StatTile
          label={t('Water (calculated)')}
          value={data ? formatVolumeRange(data.totals.litersMin, data.totals.litersMax, volUnit) : '—'}
        />
        <StatTile label={t('Watering time')} value={data ? t('{n} min', { n: Math.round(data.totals.minutes) }) : '—'} />
        <StatTile
          label={t('Pump energy')}
          value={data ? t('{n} kWh', { n: (data.totals.energyKwh + data.totals.tailKwh).toFixed(1) }) : '—'}
        />
        <StatTile
          label={data?.tariff ? t('Cost') : t('Refill tail energy')}
          value={
            data
              ? data.tariff
                ? `${((data.totals.energyKwh + data.totals.tailKwh) * data.tariff).toFixed(0)} ${data.currency ?? ''}`.trim()
                : t('{n} kWh', { n: data.totals.tailKwh.toFixed(1) })
              : '—'
          }
        />
      </SimpleGrid>

      <Card withBorder>
        <Title order={5} mb="sm">
          {t('{unit} per day (average of range)', { unit: volumeSuffix(volUnit) === 'gal' ? t('Gallons') : t('Liters') })}
        </Title>
        <BarChart
          h={220}
          data={chartData}
          dataKey="day"
          series={[{ name: 'volume', label: volLabel, color: 'blue.6' }]}
        />
      </Card>
      <Card withBorder>
        <Title order={5} mb="sm">
          {t('Minutes per day')}
        </Title>
        <BarChart
          h={220}
          data={chartData}
          dataKey="day"
          series={[{ name: 'minutes', label: t('minutes'), color: 'teal.6' }]}
        />
      </Card>
      <Card withBorder>
        <Title order={5} mb="sm">
          {t('Pump energy per day (incl. refill tail)')}
        </Title>
        <BarChart
          h={220}
          data={chartData}
          dataKey="day"
          series={[{ name: 'kWh', label: t('kWh'), color: 'grape.6' }]}
        />
      </Card>
    </Stack>
  );
}
