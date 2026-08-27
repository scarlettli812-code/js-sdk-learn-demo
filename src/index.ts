import { bitable } from '@lark-base-open/js-sdk';
import {
  scheduleProduction,
  startOfDay,
  startOfMonth,
  type DailyCapacity,
  type RegionDeliveryRow,
  type SchedulingDemand,
} from './scheduler';
import './style.css';

const TABLE_NAMES = [
  '00_排产控制台',
  '01_需求与优先级',
  '02_每日产能',
  '03_排产结果_by天',
  '04_区域交付结果',
] as const;

type TableName = (typeof TABLE_NAMES)[number];
type BaseTable = Awaited<ReturnType<typeof bitable.base.getActiveTable>>;
type FieldMeta = Awaited<ReturnType<BaseTable['getFieldMetaList']>>[number];
type RawRecord = { recordId: string; fields: Record<string, unknown> };
type WriteRecord = { fields: Record<string, unknown> };

const REQUIRED_FIELDS: Record<TableName, readonly string[]> = {
  '00_排产控制台': [
    '方案名称', '数量取整单位', '发货截点', '长停产阈值（天）',
    '排产状态', '当前运行ID', '最后运行时间', '运行说明',
  ],
  '01_需求与优先级': [
    '需求ID', '产品', '料号', '区域', '需求月份', '要货数量',
    '交付批次', '批次优先级', '是否关键首批', '批次ID',
    '料号优先级', '区域优先级', '最早可生产日', '是否参与排产', '创建时间',
  ],
  '02_每日产能': [
    '产能ID', '产品', '生产日期', '当日产能', '已锁定产能', '可排产能', '是否参与排产',
  ],
  '03_排产结果_by天': [
    '排产记录ID', '运行ID', '是否当前版本', '产品', '生产日期', '星期',
    '当日总产能', '料号', '料号优先级', '区域', '区域优先级', '需求月份',
    '关联需求ID', '关联批次ID', '交付批次', '是否SKU切换', '切换原因',
    '生产数量', '需求分配量', '可发周开始', '可发周结束',
    '停产天数', '是否恢复生产', '排产说明',
  ],
  '04_区域交付结果': [
    '区域交付ID', '运行ID', '是否当前版本', '产品', '需求月份', '区域',
    '区域总要货量', '已排数量', '覆盖状态', '月度交付状态', '首批生产日',
    '尾量生产日', '首批可发周', '最终交完周', '各周可发量', '涉及料号',
    '是否存在长停产', '恢复生产日', '恢复可发周', 'GTM交付说明',
  ],
};

const statusText = document.querySelector<HTMLElement>('#statusText')!;
const statusDot = document.querySelector<HTMLElement>('#statusDot')!;
const tableCount = document.querySelector<HTMLElement>('#tableCount')!;
const readinessText = document.querySelector<HTMLElement>('#readinessText')!;
const demandCount = document.querySelector<HTMLElement>('#demandCount')!;
const capacityCount = document.querySelector<HTMLElement>('#capacityCount')!;
const refreshButton = document.querySelector<HTMLButtonElement>('#refreshButton')!;
const scheduleButton = document.querySelector<HTMLButtonElement>('#scheduleButton')!;
const runPanel = document.querySelector<HTMLElement>('#runPanel')!;
const runSummary = document.querySelector<HTMLElement>('#runSummary')!;
const runDetails = document.querySelector<HTMLElement>('#runDetails')!;

type StatusKind = 'loading' | 'success' | 'warning' | 'error';
type TableMap = Record<TableName, BaseTable>;
let tables: TableMap | null = null;

function setStatus(message: string, kind: StatusKind): void {
  statusText.textContent = message;
  statusDot.className = `status-dot ${kind}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showRun(summary: string, details: string): void {
  runPanel.hidden = false;
  runSummary.textContent = summary;
  runDetails.textContent = details;
}

function chunk<T>(items: T[], size = 200): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function loadAllRecords(table: BaseTable): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  let pageToken: number | undefined;
  do {
    const response = await table.getRecordsByPage({ pageSize: 200, pageToken });
    records.push(...(response.records as RawRecord[]));
    if (!response.hasMore) break;
    pageToken = response.pageToken;
  } while (pageToken !== undefined);
  return records;
}

async function getRecordTotal(table: BaseTable): Promise<number> {
  const response = await table.getRecordsByPage({ pageSize: 1 });
  return response.total;
}

function mapFields(tableName: TableName, metas: FieldMeta[]): Map<string, FieldMeta> {
  const fields = new Map(metas.map((meta) => [meta.name, meta]));
  const missing = REQUIRED_FIELDS[tableName].filter((name) => !fields.has(name));
  if (missing.length > 0) throw new Error(`${tableName} 缺少字段：${missing.join('、')}`);
  return fields;
}

function cell(record: RawRecord, fields: Map<string, FieldMeta>, name: string): unknown {
  const field = fields.get(name);
  return field ? record.fields[field.id] : undefined;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toText).join('').trim();
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return toText(object.text ?? object.name ?? object.value ?? '');
  }
  return '';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }
  if (value && typeof value === 'object') return toNumber((value as Record<string, unknown>).value);
  return null;
}

function toTimestamp(value: unknown): number | null {
  const number = toNumber(value);
  if (number !== null && number > 0) return number;
  const text = toText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = toText(value).toLowerCase();
  return ['true', '1', 'yes', '是', '勾选', 'checked'].includes(text);
}

function requireField(fields: Map<string, FieldMeta>, name: string): FieldMeta {
  const field = fields.get(name);
  if (!field) throw new Error(`缺少字段：${name}`);
  return field;
}

function writeRecord(fields: Map<string, FieldMeta>, values: Record<string, unknown>): WriteRecord {
  const recordFields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    recordFields[requireField(fields, name).id] = value;
  }
  return { fields: recordFields };
}

async function addRecordsInBatches(table: BaseTable, records: WriteRecord[]): Promise<string[]> {
  const recordIds: string[] = [];
  for (const batch of chunk(records)) {
    const ids = await table.addRecords(batch as never);
    recordIds.push(...ids);
  }
  return recordIds;
}

async function setCurrentVersion(
  table: BaseTable,
  currentFieldId: string,
  recordIds: string[],
  value: boolean,
): Promise<void> {
  for (const batch of chunk(recordIds)) {
    await table.setRecords(batch.map((recordId) => ({
      recordId,
      fields: { [currentFieldId]: value },
    })) as never);
  }
}

type SelectOption = { id: string; name: string };

async function getSelectOptions(table: BaseTable, field: FieldMeta): Promise<SelectOption[]> {
  const selectField = (await table.getField(field.id)) as unknown as {
    getOptions: () => Promise<SelectOption[]>;
  };
  return selectField.getOptions();
}

function selectCell(options: SelectOption[], name: string): { id: string; text: string } {
  const option = options.find((item) => item.name === name);
  if (!option) throw new Error(`单选字段缺少选项：${name}`);
  return { id: option.id, text: option.name };
}

async function updateControl(
  table: BaseTable,
  fields: Map<string, FieldMeta>,
  recordId: string,
  status: '待刷新' | '排产中' | '已完成' | '有异常' | '运行失败',
  values: { runId?: string; note?: string; finishedAt?: number },
): Promise<void> {
  const statusMeta = requireField(fields, '排产状态');
  const statusField = (await table.getField(statusMeta.id)) as unknown as {
    getOptions: () => Promise<SelectOption[]>;
    setValue: (recordId: string, optionId: string) => Promise<boolean>;
  };
  const options = await statusField.getOptions();
  const option = options.find((item) => item.name === status);
  if (!option) throw new Error(`排产状态缺少选项：${status}`);
  await statusField.setValue(recordId, option.id);

  const recordFields: Record<string, unknown> = {};
  if (values.runId !== undefined) recordFields[requireField(fields, '当前运行ID').id] = values.runId;
  if (values.note !== undefined) recordFields[requireField(fields, '运行说明').id] = values.note;
  if (values.finishedAt !== undefined) recordFields[requireField(fields, '最后运行时间').id] = values.finishedAt;
  if (Object.keys(recordFields).length > 0) {
    await table.setRecord(recordId, { fields: recordFields } as never);
  }
}

function makeRunId(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'),
    '-', String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 6).toUpperCase()
    : Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RUN-${stamp}-${random}`;
}

function buildDailyWriteRecords(
  runId: string,
  fields: Map<string, FieldMeta>,
  rows: ReturnType<typeof scheduleProduction>['dailyRows'],
): WriteRecord[] {
  return rows.map((row) => writeRecord(fields, {
    排产记录ID: `${runId}-D-${String(row.sequence).padStart(5, '0')}`,
    运行ID: runId,
    是否当前版本: false,
    产品: row.product,
    生产日期: row.productionDate,
    星期: row.weekday,
    当日总产能: row.dayTotalCapacity,
    料号: row.sku,
    料号优先级: row.skuPriority,
    区域: row.region,
    区域优先级: row.regionPriority,
    需求月份: row.demandMonth,
    关联需求ID: row.demandId,
    关联批次ID: row.batchId,
    交付批次: row.batchName,
    是否SKU切换: row.isSkuSwitch,
    切换原因: row.switchReason,
    生产数量: row.productionQuantity,
    需求分配量: row.allocatedQuantity,
    可发周开始: row.shippingWeekStart,
    可发周结束: row.shippingWeekEnd,
    停产天数: row.stopDays,
    是否恢复生产: row.isRecovery,
    排产说明: row.explanation,
  }));
}

function buildRegionWriteRecords(
  runId: string,
  fields: Map<string, FieldMeta>,
  rows: RegionDeliveryRow[],
  coverageOptions: SelectOption[],
  monthlyOptions: SelectOption[],
): WriteRecord[] {
  return rows.map((row) => writeRecord(fields, {
    区域交付ID: `${runId}-R-${String(row.sequence).padStart(5, '0')}`,
    运行ID: runId,
    是否当前版本: false,
    产品: row.product,
    需求月份: row.demandMonth,
    区域: row.region,
    区域总要货量: row.totalDemand,
    已排数量: row.scheduledQuantity,
    覆盖状态: selectCell(coverageOptions, row.coverageStatus),
    月度交付状态: selectCell(monthlyOptions, row.monthlyDeliveryStatus),
    首批生产日: row.firstProductionDate,
    尾量生产日: row.lastProductionDate,
    首批可发周: row.firstShippingWeek,
    最终交完周: row.finalShippingWeek,
    各周可发量: row.weeklyShippingText,
    涉及料号: row.skus,
    是否存在长停产: row.hasLongStop,
    恢复生产日: row.recoveryProductionDate,
    恢复可发周: row.recoveryShippingWeek,
    GTM交付说明: row.gtmNote,
  }));
}

interface RunOutcome {
  runId: string;
  status: '已完成' | '有异常';
  dailyCount: number;
  regionCount: number;
  uncoveredQuantity: number;
  issues: string[];
}

async function runScheduling(onProgress: (message: string) => void): Promise<RunOutcome> {
  if (!tables) throw new Error('尚未连接多维表格，请先重新读取');

  onProgress('正在核对 5 张表的字段…');
  const fieldEntries = await Promise.all(TABLE_NAMES.map(async (name) => {
    const metas = await tables![name].getFieldMetaList();
    return [name, mapFields(name, metas)] as const;
  }));
  const fields = Object.fromEntries(fieldEntries) as Record<TableName, Map<string, FieldMeta>>;

  onProgress('正在读取控制台、需求和产能…');
  const [controlRecords, demandRecords, capacityRecords, oldDailyRecords, oldRegionRecords] = await Promise.all([
    loadAllRecords(tables['00_排产控制台']),
    loadAllRecords(tables['01_需求与优先级']),
    loadAllRecords(tables['02_每日产能']),
    loadAllRecords(tables['03_排产结果_by天']),
    loadAllRecords(tables['04_区域交付结果']),
  ]);

  const controlFields = fields['00_排产控制台'];
  const controlRecord = controlRecords.find((record) => toText(cell(record, controlFields, '方案名称'))) ?? controlRecords[0];
  if (!controlRecord) throw new Error('00_排产控制台 至少需要一条方案记录');

  const roundUnit = toNumber(cell(controlRecord, controlFields, '数量取整单位'));
  const longGapDays = toNumber(cell(controlRecord, controlFields, '长停产阈值（天）'));
  const shippingCutoff = toText(cell(controlRecord, controlFields, '发货截点'));
  if (roundUnit === null || roundUnit <= 0) throw new Error('控制台“数量取整单位”必须大于 0');
  if (longGapDays === null || longGapDays < 1) throw new Error('控制台“长停产阈值（天）”必须大于或等于 1');
  if (shippingCutoff !== '周四') throw new Error('当前版本仅支持发货截点“周四”');

  const activeDemandRecords = demandRecords.filter((record) =>
    toBoolean(cell(record, fields['01_需求与优先级'], '是否参与排产')),
  );
  const activeCapacityRecords = capacityRecords.filter((record) =>
    toBoolean(cell(record, fields['02_每日产能'], '是否参与排产')),
  );
  if (activeDemandRecords.length === 0) throw new Error('没有勾选“是否参与排产”的需求记录');
  if (activeCapacityRecords.length === 0) throw new Error('没有勾选“是否参与排产”的产能记录');

  const runId = makeRunId();
  await updateControl(tables['00_排产控制台'], controlFields, controlRecord.recordId, '排产中', {
    runId,
    note: '插件正在读取需求与产能，请勿重复点击。',
  });

  const issues: string[] = [];
  try {
    const demandFields = fields['01_需求与优先级'];
    const demands: SchedulingDemand[] = [];
    const batchIdCounts = new Map<string, number>();
    for (const record of activeDemandRecords) {
      const batchId = toText(cell(record, demandFields, '批次ID'));
      if (batchId) batchIdCounts.set(batchId, (batchIdCounts.get(batchId) ?? 0) + 1);
    }

    for (const [index, record] of activeDemandRecords.entries()) {
      const demandId = toText(cell(record, demandFields, '需求ID')) || record.recordId;
      const batchId = toText(cell(record, demandFields, '批次ID'));
      const batchName = toText(cell(record, demandFields, '交付批次'));
      const batchPriority = toNumber(cell(record, demandFields, '批次优先级'));
      const isCriticalFirstBatch = toBoolean(cell(record, demandFields, '是否关键首批'));
      const product = toText(cell(record, demandFields, '产品'));
      const sku = toText(cell(record, demandFields, '料号'));
      const region = toText(cell(record, demandFields, '区域'));
      const month = toTimestamp(cell(record, demandFields, '需求月份'));
      const quantity = toNumber(cell(record, demandFields, '要货数量'));
      const skuPriority = toNumber(cell(record, demandFields, '料号优先级'));
      const regionPriority = toNumber(cell(record, demandFields, '区域优先级'));
      const earliestDate = toTimestamp(cell(record, demandFields, '最早可生产日'));
      const createdAt = toTimestamp(cell(record, demandFields, '创建时间'));

      const missing: string[] = [];
      if (!batchId) missing.push('批次ID');
      if (batchId && (batchIdCounts.get(batchId) ?? 0) > 1) missing.push('唯一批次ID（当前值重复）');
      if (!batchName) missing.push('交付批次');
      if (batchPriority === null || !Number.isInteger(batchPriority) || batchPriority < 1) {
        missing.push('有效批次优先级（正整数）');
      }
      if (!product) missing.push('产品');
      if (!sku) missing.push('料号');
      if (!region) missing.push('区域');
      if (month === null) missing.push('需求月份');
      if (quantity === null || quantity <= 0) missing.push('有效要货数量');
      if (skuPriority === null) missing.push('料号优先级');
      if (regionPriority === null) missing.push('区域优先级');
      if (earliestDate === null) missing.push('最早可生产日');
      if (createdAt === null) missing.push('创建时间');
      if (missing.length > 0) issues.push(`需求 ${demandId} 缺少：${missing.join('、')}`);

      const groupable = Boolean(product && sku && region && month !== null && quantity !== null && quantity > 0);
      if (!groupable) continue;
      demands.push({
        id: demandId,
        batchId: batchId || `INVALID-${record.recordId}`,
        batchName: batchName || '未命名批次',
        batchPriority: batchPriority ?? Number.MAX_SAFE_INTEGER,
        isCriticalFirstBatch,
        product,
        sku,
        region,
        month: startOfMonth(month!),
        quantity: quantity!,
        skuPriority: skuPriority ?? Number.MAX_SAFE_INTEGER,
        regionPriority: regionPriority ?? Number.MAX_SAFE_INTEGER,
        earliestDate: startOfDay(earliestDate ?? month!),
        createdAt: createdAt ?? index,
        schedulable: missing.length === 0,
      });
    }

    const capacityFields = fields['02_每日产能'];
    const capacities: DailyCapacity[] = [];
    const capacityKeys = new Set<string>();
    for (const record of activeCapacityRecords) {
      const capacityId = toText(cell(record, capacityFields, '产能ID')) || record.recordId;
      const product = toText(cell(record, capacityFields, '产品'));
      const date = toTimestamp(cell(record, capacityFields, '生产日期'));
      const total = toNumber(cell(record, capacityFields, '当日产能'));
      const locked = toNumber(cell(record, capacityFields, '已锁定产能')) ?? 0;
      const formulaAvailable = toNumber(cell(record, capacityFields, '可排产能'));
      const available = formulaAvailable ?? (total === null ? null : total - locked);

      const missing: string[] = [];
      if (!product) missing.push('产品');
      if (date === null) missing.push('生产日期');
      if (total === null || total < 0) missing.push('有效当日产能');
      if (available === null || available < 0) missing.push('有效可排产能');
      if (missing.length > 0) {
        issues.push(`产能 ${capacityId} 缺少：${missing.join('、')}`);
        continue;
      }

      const key = `${product}\u0000${startOfDay(date!)}`;
      if (capacityKeys.has(key)) issues.push(`产品 ${product} 在同一天存在多条产能，插件已合并计算`);
      capacityKeys.add(key);
      capacities.push({
        id: capacityId,
        product,
        date: startOfDay(date!),
        totalCapacity: total!,
        availableCapacity: Math.min(total!, available!),
      });
    }

    if (demands.length === 0) throw new Error('参与排产的需求都缺少关键字段，无法生成结果');
    if (capacities.length === 0) throw new Error('参与排产的产能都缺少关键字段，无法生成结果');

    const productsWithCapacity = new Set(capacities.map((item) => item.product));
    for (const product of new Set(demands.map((item) => item.product))) {
      if (!productsWithCapacity.has(product)) issues.push(`产品 ${product} 没有可用产能`);
    }

    onProgress('正在按批次、SKU连续生产和关键首批规则分配产能…');
    const result = scheduleProduction(demands, capacities, { roundUnit, longGapDays });
    const regionTable = tables['04_区域交付结果'];
    const regionFields = fields['04_区域交付结果'];
    const [coverageOptions, monthlyOptions] = await Promise.all([
      getSelectOptions(regionTable, requireField(regionFields, '覆盖状态')),
      getSelectOptions(regionTable, requireField(regionFields, '月度交付状态')),
    ]);
    const dailyWrites = buildDailyWriteRecords(runId, fields['03_排产结果_by天'], result.dailyRows);
    const regionWrites = buildRegionWriteRecords(runId, regionFields, result.regionRows, coverageOptions, monthlyOptions);

    onProgress('正在写入新版本结果…');
    const [newDailyIds, newRegionIds] = await Promise.all([
      addRecordsInBatches(tables['03_排产结果_by天'], dailyWrites),
      addRecordsInBatches(regionTable, regionWrites),
    ]);

    onProgress('正在切换当前版本并保留历史记录…');
    const dailyCurrentField = requireField(fields['03_排产结果_by天'], '是否当前版本');
    const regionCurrentField = requireField(regionFields, '是否当前版本');
    const oldDailyCurrentIds = oldDailyRecords
      .filter((record) => toBoolean(record.fields[dailyCurrentField.id]))
      .map((record) => record.recordId);
    const oldRegionCurrentIds = oldRegionRecords
      .filter((record) => toBoolean(record.fields[regionCurrentField.id]))
      .map((record) => record.recordId);
    await Promise.all([
      setCurrentVersion(tables['03_排产结果_by天'], dailyCurrentField.id, oldDailyCurrentIds, false),
      setCurrentVersion(regionTable, regionCurrentField.id, oldRegionCurrentIds, false),
    ]);
    await Promise.all([
      setCurrentVersion(tables['03_排产结果_by天'], dailyCurrentField.id, newDailyIds, true),
      setCurrentVersion(regionTable, regionCurrentField.id, newRegionIds, true),
    ]);

    if (result.uncoveredQuantity > 0) {
      issues.push(`未覆盖需求 ${result.uncoveredDemandCount} 条，合计 ${result.uncoveredQuantity}`);
    }
    if (result.roundedTargetShortfallQuantity > 0) {
      issues.push(
        `需求已覆盖但取整目标未完成 ${result.roundedTargetShortfallCount} 个批次，` +
        `合计差 ${result.roundedTargetShortfallQuantity}`,
      );
    }
    const finalStatus: '已完成' | '有异常' = issues.length > 0 ? '有异常' : '已完成';
    const issueText = issues.length > 0 ? `；${issues.slice(0, 8).join('；')}` : '';
    const note = `运行完成：生成日排产 ${result.dailyRows.length} 条、区域交付 ${result.regionRows.length} 条${issueText}`;
    await updateControl(tables['00_排产控制台'], controlFields, controlRecord.recordId, finalStatus, {
      runId,
      note,
      finishedAt: Date.now(),
    });

    return {
      runId,
      status: finalStatus,
      dailyCount: result.dailyRows.length,
      regionCount: result.regionRows.length,
      uncoveredQuantity: result.uncoveredQuantity,
      issues,
    };
  } catch (error) {
    const message = errorMessage(error);
    await updateControl(tables['00_排产控制台'], controlFields, controlRecord.recordId, '运行失败', {
      runId,
      note: message,
      finishedAt: Date.now(),
    }).catch((controlError) => console.error('Failed to update control status:', controlError));
    throw error;
  }
}

async function loadTables(): Promise<void> {
  setStatus('正在连接飞书多维表格…', 'loading');
  scheduleButton.disabled = true;
  refreshButton.disabled = true;
  readinessText.textContent = '正在核对数据表…';
  try {
    const metaList = await bitable.base.getTableMetaList();
    const metaByName = new Map(metaList.map((meta) => [meta.name, meta]));
    const missing = TABLE_NAMES.filter((name) => !metaByName.has(name));
    tableCount.textContent = String(TABLE_NAMES.length - missing.length);
    if (missing.length > 0) {
      tables = null;
      readinessText.textContent = `缺少：${missing.join('、')}`;
      setStatus('表结构还不完整，暂时不能排产', 'error');
      return;
    }

    const entries = await Promise.all(TABLE_NAMES.map(async (name) => {
      const meta = metaByName.get(name)!;
      return [name, await bitable.base.getTableById(meta.id)] as const;
    }));
    tables = Object.fromEntries(entries) as TableMap;

    const [demands, capacities] = await Promise.all([
      getRecordTotal(tables['01_需求与优先级']),
      getRecordTotal(tables['02_每日产能']),
    ]);
    demandCount.textContent = String(demands);
    capacityCount.textContent = String(capacities);
    readinessText.textContent = '5 张表已就绪，数据只在当前多维表格内处理。';
    scheduleButton.disabled = false;
    setStatus('连接成功，可以开始排产', 'success');
  } catch (error) {
    console.error('Failed to connect to Lark Base:', error);
    tables = null;
    readinessText.textContent = '请确认插件从目标多维表格中打开。';
    setStatus(`连接失败：${errorMessage(error)}`, 'error');
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', () => void loadTables());

scheduleButton.addEventListener('click', async () => {
  scheduleButton.disabled = true;
  refreshButton.disabled = true;
  setStatus('正在重新排产…', 'loading');
  showRun('排产进行中', '正在准备数据…');
  try {
    const outcome = await runScheduling((message) => showRun('排产进行中', message));
    const detail = `运行ID：${outcome.runId}\n日排产：${outcome.dailyCount} 条；区域交付：${outcome.regionCount} 条` +
      (outcome.uncoveredQuantity > 0 ? `；未覆盖：${outcome.uncoveredQuantity}` : '；需求已全部覆盖') +
      (outcome.issues.length > 0 ? `\n提醒：${outcome.issues.slice(0, 3).join('；')}` : '');
    showRun(outcome.status === '已完成' ? '排产完成' : '排产完成，但有异常', detail);
    setStatus(
      outcome.status === '已完成' ? '新排产结果已写回' : '结果已写回，请查看异常说明',
      outcome.status === '已完成' ? 'success' : 'warning',
    );
  } catch (error) {
    console.error('Scheduling failed:', error);
    const message = errorMessage(error);
    showRun('排产失败', message);
    setStatus(`排产失败：${message}`, 'error');
  } finally {
    scheduleButton.disabled = tables === null;
    refreshButton.disabled = false;
  }
});

void loadTables();
