import { describe, expect, it } from 'vitest';
import {
  scheduleProduction,
  shippingWeek,
  startOfDay,
  type DailyCapacity,
  type SchedulingDemand,
} from './scheduler';

function day(year: number, month: number, date: number): number {
  return new Date(year, month - 1, date).getTime();
}

function demand(overrides: Partial<SchedulingDemand> = {}): SchedulingDemand {
  return {
    id: 'D1',
    product: 'P1',
    sku: 'SKU1',
    region: '华东',
    month: day(2026, 8, 1),
    quantity: 10,
    skuPriority: 1,
    regionPriority: 1,
    earliestDate: day(2026, 8, 3),
    createdAt: day(2026, 7, 1),
    schedulable: true,
    ...overrides,
  };
}

function capacity(overrides: Partial<DailyCapacity> = {}): DailyCapacity {
  return {
    id: 'C1',
    product: 'P1',
    date: day(2026, 8, 3),
    totalCapacity: 100,
    availableCapacity: 100,
    ...overrides,
  };
}

describe('scheduleProduction', () => {
  it('按区域优先级分配，并且计划余量不覆盖下一条需求', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'D2', region: '华南', regionPriority: 2, quantity: 10 }),
        demand({ id: 'D1', region: '华东', regionPriority: 1, quantity: 15 }),
      ],
      [capacity({ totalCapacity: 20, availableCapacity: 20 })],
      { roundUnit: 10, longGapDays: 7 },
    );

    expect(result.dailyRows).toHaveLength(1);
    expect(result.dailyRows[0]).toMatchObject({
      demandId: 'D1',
      productionQuantity: 20,
      allocatedQuantity: 15,
      planSurplus: 5,
    });
    expect(result.uncoveredQuantity).toBe(10);
  });

  it('遵守最早可生产日，并且每天不超过可排产能', () => {
    const result = scheduleProduction(
      [demand({ quantity: 25, earliestDate: day(2026, 8, 4) })],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 100 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), totalCapacity: 20, availableCapacity: 20 }),
        capacity({ id: 'C3', date: day(2026, 8, 5), totalCapacity: 10, availableCapacity: 10 }),
      ],
      { roundUnit: 10, longGapDays: 7 },
    );

    expect(result.dailyRows.map((row) => row.productionDate)).toEqual([
      startOfDay(day(2026, 8, 4)),
      startOfDay(day(2026, 8, 5)),
    ]);
    expect(result.dailyRows.map((row) => row.productionQuantity)).toEqual([20, 10]);
    expect(result.dailyRows.map((row) => row.allocatedQuantity)).toEqual([20, 5]);
  });

  it('周四生产计入本周，周五生产计入下周', () => {
    expect(shippingWeek(day(2026, 8, 6)).start).toBe(day(2026, 8, 3));
    expect(shippingWeek(day(2026, 8, 7)).start).toBe(day(2026, 8, 10));
  });

  it('同一区域多个料号全部覆盖后才完成，并判断跨月', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'D1', sku: 'SKU1', quantity: 10, month: day(2026, 8, 1) }),
        demand({ id: 'D2', sku: 'SKU2', skuPriority: 2, quantity: 10, month: day(2026, 8, 1) }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 8, 31), availableCapacity: 10 }),
        capacity({ id: 'C2', date: day(2026, 9, 7), availableCapacity: 10 }),
      ],
      { roundUnit: 10, longGapDays: 7 },
    );

    expect(result.regionRows).toHaveLength(1);
    expect(result.regionRows[0]).toMatchObject({
      totalDemand: 20,
      scheduledQuantity: 20,
      coverageStatus: '已完成',
      monthlyDeliveryStatus: '跨月完成',
    });
  });

  it('相邻生产日之间空档达到阈值时标记恢复生产', () => {
    const result = scheduleProduction(
      [demand({ quantity: 20 })],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 10 }),
        capacity({ id: 'C2', date: day(2026, 8, 11), availableCapacity: 10 }),
      ],
      { roundUnit: 10, longGapDays: 7 },
    );

    expect(result.recoveryEvents).toHaveLength(1);
    expect(result.recoveryEvents[0].stopDays).toBe(7);
    expect(result.dailyRows[1].isRecovery).toBe(true);
    expect(result.regionRows[0].hasLongStop).toBe(true);
  });
});
