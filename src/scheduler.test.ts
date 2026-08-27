import { describe, expect, it } from 'vitest';
import {
  assertNoDailyCapacityOverrun,
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
  const id = overrides.id ?? 'D1';
  return {
    id,
    batchId: `${id}-B01`,
    batchName: '默认批次',
    batchPriority: 1,
    isCriticalFirstBatch: false,
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

const settings = { roundUnit: 10, longGapDays: 7 };

describe('scheduleProduction V2', () => {
  it('按批次优先级早于区域优先级排序，且计划余量不覆盖下一批次', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'D2', batchPriority: 2, region: '华东', regionPriority: 1, quantity: 10 }),
        demand({ id: 'D1', batchPriority: 1, region: '华南', regionPriority: 2, quantity: 15 }),
      ],
      [capacity({ totalCapacity: 20, availableCapacity: 20 })],
      settings,
    );

    expect(result.dailyRows).toHaveLength(1);
    expect(result.dailyRows[0]).toMatchObject({
      batchId: 'D1-B01',
      productionQuantity: 20,
      allocatedQuantity: 15,
      planSurplus: 5,
    });
    expect(result.uncoveredQuantity).toBe(10);
  });

  it('SKU优先级高于批次和区域优先级', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'LOW-SKU', sku: 'SKU2', skuPriority: 2, batchPriority: 1, regionPriority: 1 }),
        demand({ id: 'HIGH-SKU', sku: 'SKU1', skuPriority: 1, batchPriority: 99, regionPriority: 99 }),
      ],
      [capacity({ availableCapacity: 10 })],
      settings,
    );

    expect(result.dailyRows[0].demandId).toBe('HIGH-SKU');
  });

  it('只将批次需求向上取10，日产能315和346.5分别可用315和346', () => {
    const result = scheduleProduction(
      [demand({ quantity: 3015 })],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), totalCapacity: 315, availableCapacity: 315 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), totalCapacity: 346.5, availableCapacity: 346.5 }),
        capacity({ id: 'C3', date: day(2026, 8, 5), totalCapacity: 2359, availableCapacity: 2359 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => row.productionQuantity)).toEqual([315, 346, 2359]);
    expect(result.dailyRows.reduce((sum, row) => sum + row.productionQuantity, 0)).toBe(3020);
    expect(result.dailyRows.reduce((sum, row) => sum + row.allocatedQuantity, 0)).toBe(3015);
    expect(result.dailyRows.reduce((sum, row) => sum + row.planSurplus, 0)).toBe(5);
  });

  it('真实需求已覆盖但取整目标未完成时单独报告', () => {
    const result = scheduleProduction(
      [demand({ quantity: 3015 })],
      [capacity({ totalCapacity: 3015, availableCapacity: 3015 })],
      settings,
    );

    expect(result.uncoveredQuantity).toBe(0);
    expect(result.roundedTargetShortfallCount).toBe(1);
    expect(result.roundedTargetShortfallQuantity).toBe(5);
  });

  it('当前批次未完成时继续生产当前SKU，普通Ready批次不抢占', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'CURRENT', sku: 'SKU1', quantity: 200, earliestDate: day(2026, 8, 3) }),
        demand({ id: 'OTHER', sku: 'SKU2', skuPriority: 2, quantity: 100, earliestDate: day(2026, 8, 4) }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 100 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), availableCapacity: 100 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => row.sku)).toEqual(['SKU1', 'SKU1']);
    expect(result.dailyRows[1].switchReason).toBe('连续生产');
  });

  it('关键首批Ready后切换SKU，完成后当天切回原SKU', () => {
    const result = scheduleProduction(
      [
        demand({
          id: 'HV-D',
          batchId: 'HV-B01',
          batchName: '欧洲高压首批',
          sku: 'HV',
          quantity: 1200,
          skuPriority: 1,
          earliestDate: day(2026, 9, 14),
        }),
        demand({
          id: 'LV-D',
          batchId: 'LV-B01',
          batchName: '欧洲低压关键首批',
          sku: 'LV',
          quantity: 495,
          skuPriority: 2,
          isCriticalFirstBatch: true,
          earliestDate: day(2026, 9, 16),
        }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 9, 14), totalCapacity: 315, availableCapacity: 315 }),
        capacity({ id: 'C2', date: day(2026, 9, 15), totalCapacity: 315, availableCapacity: 315 }),
        capacity({ id: 'C3', date: day(2026, 9, 16), totalCapacity: 346.5, availableCapacity: 346.5 }),
        capacity({ id: 'C4', date: day(2026, 9, 17), totalCapacity: 315, availableCapacity: 315 }),
        capacity({ id: 'C5', date: day(2026, 9, 18), totalCapacity: 315, availableCapacity: 315 }),
        capacity({ id: 'C6', date: day(2026, 9, 19), totalCapacity: 315, availableCapacity: 315 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => [
      startOfDay(row.productionDate), row.sku, row.productionQuantity, row.switchReason,
    ])).toEqual([
      [day(2026, 9, 14), 'HV', 315, '初始排产'],
      [day(2026, 9, 15), 'HV', 315, '连续生产'],
      [day(2026, 9, 16), 'LV', 346, '关键首批触发'],
      [day(2026, 9, 17), 'LV', 154, '连续生产'],
      [day(2026, 9, 17), 'HV', 161, '关键首批完成后切回'],
      [day(2026, 9, 18), 'HV', 315, '连续生产'],
      [day(2026, 9, 19), 'HV', 94, '连续生产'],
    ]);
    expect(result.dailyRows.filter((row) => row.isSkuSwitch)).toHaveLength(2);
    expect(result.uncoveredQuantity).toBe(0);
  });

  it('初始或批次完成后重排时，Ready关键首批优先于普通批次', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'NORMAL', sku: 'SKU1', skuPriority: 1 }),
        demand({ id: 'CRITICAL', sku: 'SKU2', skuPriority: 2, isCriticalFirstBatch: true }),
      ],
      [capacity({ availableCapacity: 10 })],
      settings,
    );

    expect(result.dailyRows[0]).toMatchObject({ demandId: 'CRITICAL', switchReason: '初始排产' });
  });

  it('关键首批一旦开始就先完成，不被另一个关键首批中途中断', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'NORMAL', sku: 'SKU1', quantity: 200, earliestDate: day(2026, 8, 3) }),
        demand({
          id: 'CRITICAL-1', sku: 'SKU2', skuPriority: 2, quantity: 200,
          earliestDate: day(2026, 8, 4), isCriticalFirstBatch: true,
        }),
        demand({
          id: 'CRITICAL-2', sku: 'SKU3', skuPriority: 3, quantity: 100,
          earliestDate: day(2026, 8, 5), isCriticalFirstBatch: true,
        }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 100 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), availableCapacity: 100 }),
        capacity({ id: 'C3', date: day(2026, 8, 5), availableCapacity: 100 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => row.sku)).toEqual(['SKU1', 'SKU2', 'SKU2']);
  });

  it('同SKU关键首批不触发SKU切换', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'NORMAL', batchId: 'SKU1-B01', sku: 'SKU1', quantity: 200 }),
        demand({
          id: 'CRITICAL', batchId: 'SKU1-B02', sku: 'SKU1', skuPriority: 2,
          quantity: 100, earliestDate: day(2026, 8, 4), isCriticalFirstBatch: true,
        }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 100 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), availableCapacity: 100 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => row.batchId)).toEqual(['SKU1-B01', 'SKU1-B01']);
    expect(result.dailyRows.some((row) => row.isSkuSwitch)).toBe(false);
  });

  it('批次当天完成后重新扫描Ready任务并使用剩余产能', () => {
    const result = scheduleProduction(
      [demand({ id: 'D1', quantity: 10 }), demand({ id: 'D2', quantity: 10, skuPriority: 2 })],
      [capacity({ availableCapacity: 20 })],
      settings,
    );

    expect(result.dailyRows.map((row) => row.demandId)).toEqual(['D1', 'D2']);
    expect(result.dailyRows.reduce((sum, row) => sum + row.productionQuantity, 0)).toBe(20);
    expect(result.dailyRows.map((row) => row.dayTotalCapacity)).toEqual([100, null]);
    expect(result.dailyRows[1].switchReason).toBe('批次完成后重排');
  });

  it('写入前独立校验同产品同一天不得超过可排产能', () => {
    const date = day(2026, 8, 3);
    const rows = [
      { product: 'P1', productionDate: date, productionQuantity: 6 },
      { product: 'P1', productionDate: date, productionQuantity: 5 },
    ];

    expect(() => assertNoDailyCapacityOverrun(
      rows,
      [capacity({ product: 'P1', date, totalCapacity: 10, availableCapacity: 10 })],
    )).toThrow('当日超产：P1 2026-08-03 生产 11，可排产能 10，超出 1');
  });

  it('遵守最早可生产日，并且每天不超过可排产能', () => {
    const result = scheduleProduction(
      [demand({ quantity: 25, earliestDate: day(2026, 8, 4) })],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 100 }),
        capacity({ id: 'C2', date: day(2026, 8, 4), totalCapacity: 20, availableCapacity: 20 }),
        capacity({ id: 'C3', date: day(2026, 8, 5), totalCapacity: 10, availableCapacity: 10 }),
      ],
      settings,
    );

    expect(result.dailyRows.map((row) => row.productionDate)).toEqual([
      startOfDay(day(2026, 8, 4)), startOfDay(day(2026, 8, 5)),
    ]);
    expect(result.dailyRows.map((row) => row.productionQuantity)).toEqual([20, 10]);
    expect(result.dailyRows.map((row) => row.allocatedQuantity)).toEqual([20, 5]);
  });

  it('周四生产计入本周，周五生产计入下周', () => {
    expect(shippingWeek(day(2026, 8, 6)).start).toBe(day(2026, 8, 3));
    expect(shippingWeek(day(2026, 8, 7)).start).toBe(day(2026, 8, 10));
  });

  it('同一区域多个批次全部覆盖后才完成，并判断跨月', () => {
    const result = scheduleProduction(
      [
        demand({ id: 'D1', sku: 'SKU1', quantity: 10, month: day(2026, 8, 1) }),
        demand({ id: 'D2', sku: 'SKU2', skuPriority: 2, quantity: 10, month: day(2026, 8, 1) }),
      ],
      [
        capacity({ id: 'C1', date: day(2026, 8, 31), availableCapacity: 10 }),
        capacity({ id: 'C2', date: day(2026, 9, 7), availableCapacity: 10 }),
      ],
      settings,
    );

    expect(result.regionRows).toHaveLength(1);
    expect(result.regionRows[0]).toMatchObject({
      totalDemand: 20,
      scheduledQuantity: 20,
      coverageStatus: '已完成',
      monthlyDeliveryStatus: '跨月完成',
    });
  });

  it('不同产品不共用产能', () => {
    const result = scheduleProduction(
      [demand({ id: 'P1-D', product: 'P1' }), demand({ id: 'P2-D', product: 'P2' })],
      [capacity({ product: 'P1', availableCapacity: 10 })],
      settings,
    );

    expect(result.dailyRows.map((row) => row.product)).toEqual(['P1']);
    expect(result.uncoveredQuantity).toBe(10);
  });

  it('相邻生产日之间空档达到阈值时标记恢复生产', () => {
    const result = scheduleProduction(
      [demand({ quantity: 20 })],
      [
        capacity({ id: 'C1', date: day(2026, 8, 3), availableCapacity: 10 }),
        capacity({ id: 'C2', date: day(2026, 8, 11), availableCapacity: 10 }),
      ],
      settings,
    );

    expect(result.recoveryEvents).toHaveLength(1);
    expect(result.recoveryEvents[0].stopDays).toBe(7);
    expect(result.dailyRows[1].isRecovery).toBe(true);
    expect(result.regionRows[0].hasLongStop).toBe(true);
  });
});
