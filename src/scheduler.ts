export interface SchedulingDemand {
  id: string;
  product: string;
  sku: string;
  region: string;
  month: number;
  quantity: number;
  skuPriority: number;
  regionPriority: number;
  earliestDate: number;
  createdAt: number;
  schedulable: boolean;
}

export interface DailyCapacity {
  id: string;
  product: string;
  date: number;
  totalCapacity: number;
  availableCapacity: number;
}

export interface SchedulerSettings {
  roundUnit: number;
  longGapDays: number;
}

export interface DailyScheduleRow {
  sequence: number;
  demandId: string;
  product: string;
  productionDate: number;
  weekday: string;
  dayTotalCapacity: number;
  sku: string;
  skuPriority: number;
  region: string;
  regionPriority: number;
  demandMonth: number;
  productionQuantity: number;
  allocatedQuantity: number;
  planSurplus: number;
  shippingWeekStart: number;
  shippingWeekEnd: number;
  stopDays: number;
  isRecovery: boolean;
  explanation: string;
}

export interface RecoveryEvent {
  product: string;
  sku: string;
  previousProductionDate: number;
  recoveryProductionDate: number;
  stopDays: number;
  recoveryShippingWeek: number;
}

export type CoverageStatus = '未开始' | '部分覆盖' | '已完成';
export type MonthlyDeliveryStatus = '按月完成' | '跨月完成' | '未完成';

export interface RegionDeliveryRow {
  sequence: number;
  product: string;
  demandMonth: number;
  region: string;
  totalDemand: number;
  scheduledQuantity: number;
  unscheduledQuantity: number;
  coverageStatus: CoverageStatus;
  monthlyDeliveryStatus: MonthlyDeliveryStatus;
  firstProductionDate: number | null;
  lastProductionDate: number | null;
  firstShippingWeek: number | null;
  finalShippingWeek: number | null;
  weeklyShippingText: string;
  skus: string;
  hasLongStop: boolean;
  recoveryProductionDate: number | null;
  recoveryShippingWeek: number | null;
  gtmNote: string;
}

export interface SchedulingResult {
  dailyRows: DailyScheduleRow[];
  regionRows: RegionDeliveryRow[];
  recoveryEvents: RecoveryEvent[];
  uncoveredDemandCount: number;
  uncoveredQuantity: number;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const EPSILON = 1e-9;

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function startOfMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

export function calendarDayDifference(later: number, earlier: number): number {
  const laterDate = new Date(later);
  const earlierDate = new Date(earlier);
  const laterUtc = Date.UTC(laterDate.getFullYear(), laterDate.getMonth(), laterDate.getDate());
  const earlierUtc = Date.UTC(earlierDate.getFullYear(), earlierDate.getMonth(), earlierDate.getDate());
  return Math.round((laterUtc - earlierUtc) / 86_400_000);
}

export function shippingWeek(productionDate: number): { start: number; end: number } {
  const normalized = startOfDay(productionDate);
  const day = new Date(normalized).getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  let monday = addDays(normalized, -daysFromMonday);

  if (day === 0 || day === 5 || day === 6) {
    monday = addDays(monday, 7);
  }

  return { start: monday, end: addDays(monday, 6) };
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthEnd(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getTime();
}

function capacityKey(product: string, date: number): string {
  return `${product}\u0000${startOfDay(date)}`;
}

function groupKey(product: string, month: number, region: string): string {
  return `${product}\u0000${startOfMonth(month)}\u0000${region}`;
}

function demandSort(a: SchedulingDemand, b: SchedulingDemand): number {
  return (
    startOfMonth(a.month) - startOfMonth(b.month) ||
    a.skuPriority - b.skuPriority ||
    a.regionPriority - b.regionPriority ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id, 'zh-CN')
  );
}

function aggregateCapacities(capacities: DailyCapacity[]): Array<DailyCapacity & { remaining: number }> {
  const byDay = new Map<string, DailyCapacity & { remaining: number }>();

  for (const capacity of capacities) {
    const date = startOfDay(capacity.date);
    const key = capacityKey(capacity.product, date);
    const existing = byDay.get(key);
    if (existing) {
      existing.id += `,${capacity.id}`;
      existing.totalCapacity += Math.max(0, capacity.totalCapacity);
      existing.availableCapacity += Math.max(0, capacity.availableCapacity);
      existing.remaining += Math.max(0, capacity.availableCapacity);
    } else {
      const available = Math.max(0, capacity.availableCapacity);
      byDay.set(key, {
        ...capacity,
        date,
        totalCapacity: Math.max(0, capacity.totalCapacity),
        availableCapacity: available,
        remaining: available,
      });
    }
  }

  return [...byDay.values()].sort(
    (a, b) => a.product.localeCompare(b.product, 'zh-CN') || a.date - b.date,
  );
}

function applyRecoveryMarkers(
  rows: DailyScheduleRow[],
  longGapDays: number,
): RecoveryEvent[] {
  const rowsBySku = new Map<string, DailyScheduleRow[]>();
  for (const row of rows) {
    const key = `${row.product}\u0000${row.sku}`;
    const list = rowsBySku.get(key) ?? [];
    list.push(row);
    rowsBySku.set(key, list);
  }

  const events: RecoveryEvent[] = [];
  for (const skuRows of rowsBySku.values()) {
    const dates = [...new Set(skuRows.map((row) => startOfDay(row.productionDate)))].sort((a, b) => a - b);
    for (let index = 1; index < dates.length; index += 1) {
      const stopDays = calendarDayDifference(dates[index], dates[index - 1]) - 1;
      if (stopDays < longGapDays) continue;

      const recoveryDate = dates[index];
      const event: RecoveryEvent = {
        product: skuRows[0].product,
        sku: skuRows[0].sku,
        previousProductionDate: dates[index - 1],
        recoveryProductionDate: recoveryDate,
        stopDays,
        recoveryShippingWeek: shippingWeek(recoveryDate).start,
      };
      events.push(event);

      for (const row of skuRows) {
        if (startOfDay(row.productionDate) === recoveryDate) {
          row.stopDays = Math.max(row.stopDays, stopDays);
          row.isRecovery = true;
          row.explanation += `；停产 ${stopDays} 天后恢复生产`;
        }
      }
    }
  }

  return events.sort(
    (a, b) =>
      a.recoveryProductionDate - b.recoveryProductionDate ||
      a.product.localeCompare(b.product, 'zh-CN') ||
      a.sku.localeCompare(b.sku, 'zh-CN'),
  );
}

function buildRegionRows(
  demands: SchedulingDemand[],
  dailyRows: DailyScheduleRow[],
  recoveryEvents: RecoveryEvent[],
): RegionDeliveryRow[] {
  const demandGroups = new Map<string, SchedulingDemand[]>();
  for (const demand of demands) {
    const key = groupKey(demand.product, demand.month, demand.region);
    const list = demandGroups.get(key) ?? [];
    list.push(demand);
    demandGroups.set(key, list);
  }

  const rowsByDemand = new Map<string, DailyScheduleRow[]>();
  for (const row of dailyRows) {
    const list = rowsByDemand.get(row.demandId) ?? [];
    list.push(row);
    rowsByDemand.set(row.demandId, list);
  }

  const result: RegionDeliveryRow[] = [];
  const orderedGroups = [...demandGroups.values()].sort((a, b) => {
    const firstA = a[0];
    const firstB = b[0];
    return (
      firstA.product.localeCompare(firstB.product, 'zh-CN') ||
      startOfMonth(firstA.month) - startOfMonth(firstB.month) ||
      firstA.regionPriority - firstB.regionPriority ||
      firstA.region.localeCompare(firstB.region, 'zh-CN')
    );
  });

  for (const group of orderedGroups) {
    const groupRows = group.flatMap((demand) => rowsByDemand.get(demand.id) ?? []);
    const totalDemand = group.reduce((sum, demand) => sum + demand.quantity, 0);
    const scheduledQuantity = groupRows.reduce((sum, row) => sum + row.allocatedQuantity, 0);
    const unscheduledQuantity = Math.max(0, totalDemand - scheduledQuantity);
    const coverageStatus: CoverageStatus =
      scheduledQuantity <= EPSILON
        ? '未开始'
        : unscheduledQuantity > EPSILON
          ? '部分覆盖'
          : '已完成';

    const productionDates = groupRows.map((row) => row.productionDate).sort((a, b) => a - b);
    const shippingWeeks = groupRows.map((row) => row.shippingWeekStart).sort((a, b) => a - b);
    const firstProductionDate = productionDates[0] ?? null;
    const lastProductionDate = productionDates.length > 0 ? productionDates[productionDates.length - 1] : null;
    const firstShippingWeek = shippingWeeks[0] ?? null;
    const finalShippingWeek = shippingWeeks.length > 0 ? shippingWeeks[shippingWeeks.length - 1] : null;

    let monthlyDeliveryStatus: MonthlyDeliveryStatus = '未完成';
    if (coverageStatus === '已完成' && finalShippingWeek !== null) {
      monthlyDeliveryStatus = finalShippingWeek > monthEnd(group[0].month) ? '跨月完成' : '按月完成';
    }

    const weekly = new Map<number, number>();
    for (const row of groupRows) {
      weekly.set(row.shippingWeekStart, (weekly.get(row.shippingWeekStart) ?? 0) + row.allocatedQuantity);
    }
    const weeklyShippingText = [...weekly.entries()]
      .sort(([a], [b]) => a - b)
      .map(([week, quantity]) => `${formatDate(week)}周：${quantity}`)
      .join('\n');

    const skus = [...new Set([...group].sort(demandSort).map((demand) => demand.sku))];
    const applicableRecoveries = recoveryEvents.filter((event) =>
      groupRows.some(
        (row) =>
          row.sku === event.sku &&
          row.product === event.product &&
          row.productionDate >= event.recoveryProductionDate,
      ),
    );
    const firstRecovery = applicableRecoveries[0] ?? null;

    let gtmNote: string;
    if (coverageStatus !== '已完成') {
      gtmNote = `尚有 ${unscheduledQuantity} 未排，需补充产能或完善参数`;
    } else if (monthlyDeliveryStatus === '跨月完成') {
      gtmNote = `${formatDate(finalShippingWeek!)}周全部交完（跨月）`;
    } else {
      gtmNote = `${formatDate(finalShippingWeek!)}周全部交完`;
    }
    if (firstRecovery) {
      gtmNote += `；${formatDate(firstRecovery.recoveryProductionDate)}恢复生产`;
    }

    result.push({
      sequence: result.length + 1,
      product: group[0].product,
      demandMonth: startOfMonth(group[0].month),
      region: group[0].region,
      totalDemand,
      scheduledQuantity,
      unscheduledQuantity,
      coverageStatus,
      monthlyDeliveryStatus,
      firstProductionDate,
      lastProductionDate,
      firstShippingWeek,
      finalShippingWeek,
      weeklyShippingText: weeklyShippingText || '暂无可发量',
      skus: skus.join('、'),
      hasLongStop: applicableRecoveries.length > 0,
      recoveryProductionDate: firstRecovery?.recoveryProductionDate ?? null,
      recoveryShippingWeek: firstRecovery?.recoveryShippingWeek ?? null,
      gtmNote,
    });
  }

  return result;
}

export function scheduleProduction(
  demands: SchedulingDemand[],
  capacities: DailyCapacity[],
  settings: SchedulerSettings,
): SchedulingResult {
  if (!Number.isFinite(settings.roundUnit) || settings.roundUnit <= 0) {
    throw new Error('数量取整单位必须是大于 0 的数字');
  }
  if (!Number.isFinite(settings.longGapDays) || settings.longGapDays < 1) {
    throw new Error('长停产阈值必须是大于或等于 1 的数字');
  }

  const orderedDemands = [...demands].sort(demandSort);
  const aggregatedCapacities = aggregateCapacities(capacities);
  const capacitiesByProduct = new Map<string, Array<DailyCapacity & { remaining: number }>>();
  for (const capacity of aggregatedCapacities) {
    const list = capacitiesByProduct.get(capacity.product) ?? [];
    list.push(capacity);
    capacitiesByProduct.set(capacity.product, list);
  }

  const dailyRows: DailyScheduleRow[] = [];
  for (const demand of orderedDemands) {
    if (!demand.schedulable) continue;

    let remainingDemand = demand.quantity;
    const productCapacities = capacitiesByProduct.get(demand.product) ?? [];
    for (const capacity of productCapacities) {
      if (remainingDemand <= EPSILON) break;
      if (capacity.date < startOfDay(demand.earliestDate)) continue;

      const maxProduction = Math.floor((capacity.remaining + EPSILON) / settings.roundUnit) * settings.roundUnit;
      if (maxProduction <= 0) continue;

      const neededProduction = Math.ceil((remainingDemand - EPSILON) / settings.roundUnit) * settings.roundUnit;
      const productionQuantity = Math.min(maxProduction, neededProduction);
      const allocatedQuantity = Math.min(remainingDemand, productionQuantity);
      const planSurplus = productionQuantity - allocatedQuantity;
      const week = shippingWeek(capacity.date);

      capacity.remaining -= productionQuantity;
      remainingDemand -= allocatedQuantity;

      dailyRows.push({
        sequence: dailyRows.length + 1,
        demandId: demand.id,
        product: demand.product,
        productionDate: capacity.date,
        weekday: WEEKDAYS[new Date(capacity.date).getDay()],
        dayTotalCapacity: capacity.totalCapacity,
        sku: demand.sku,
        skuPriority: demand.skuPriority,
        region: demand.region,
        regionPriority: demand.regionPriority,
        demandMonth: startOfMonth(demand.month),
        productionQuantity,
        allocatedQuantity,
        planSurplus,
        shippingWeekStart: week.start,
        shippingWeekEnd: week.end,
        stopDays: 0,
        isRecovery: false,
        explanation:
          `需求 ${demand.id}：分配 ${allocatedQuantity}，生产 ${productionQuantity}` +
          (planSurplus > EPSILON ? `，计划余量 ${planSurplus}` : ''),
      });
    }
  }

  const recoveryEvents = applyRecoveryMarkers(dailyRows, settings.longGapDays);
  const regionRows = buildRegionRows(orderedDemands, dailyRows, recoveryEvents);
  const uncoveredRows = regionRows.filter((row) => row.unscheduledQuantity > EPSILON);

  return {
    dailyRows,
    regionRows,
    recoveryEvents,
    uncoveredDemandCount: orderedDemands.filter((demand) => {
      const allocated = dailyRows
        .filter((row) => row.demandId === demand.id)
        .reduce((sum, row) => sum + row.allocatedQuantity, 0);
      return demand.quantity - allocated > EPSILON;
    }).length,
    uncoveredQuantity: uncoveredRows.reduce((sum, row) => sum + row.unscheduledQuantity, 0),
  };
}
