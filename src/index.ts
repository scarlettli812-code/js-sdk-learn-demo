import { bitable } from '@lark-base-open/js-sdk';
import './style.css';

const tableSelect = document.querySelector<HTMLSelectElement>('#tableSelect')!;
const tableCount = document.querySelector<HTMLSpanElement>('#tableCount')!;
const statusText = document.querySelector<HTMLElement>('#statusText')!;
const statusDot = document.querySelector<HTMLElement>('#statusDot')!;
const refreshButton = document.querySelector<HTMLButtonElement>('#refreshButton')!;
const addRecordButton = document.querySelector<HTMLButtonElement>('#addRecordButton')!;

type StatusKind = 'loading' | 'success' | 'error';

function setStatus(message: string, kind: StatusKind): void {
  statusText.textContent = message;
  statusDot.className = 'status-dot ' + kind;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadTables(): Promise<void> {
  setStatus('正在连接飞书多维表格…', 'loading');
  tableSelect.disabled = true;
  addRecordButton.disabled = true;

  try {
    const [tableList, selection] = await Promise.all([
      bitable.base.getTableMetaList(),
      bitable.base.getSelection(),
    ]);

    tableSelect.innerHTML = '';
    for (const table of tableList) {
      const option = document.createElement('option');
      option.value = table.id;
      option.textContent = table.name;
      tableSelect.append(option);
    }

    if (selection.tableId && tableList.some((table) => table.id === selection.tableId)) {
      tableSelect.value = selection.tableId;
    }

    tableCount.textContent = String(tableList.length);
    tableSelect.disabled = tableList.length === 0;
    addRecordButton.disabled = tableList.length === 0;
    setStatus(tableList.length > 0 ? '连接成功，可以开始测试' : '连接成功，但当前没有数据表', 'success');
  } catch (error) {
    console.error('Failed to connect to Lark Base:', error);
    tableSelect.innerHTML = '<option>未读取到数据表</option>';
    tableCount.textContent = '0';
    setStatus('请从飞书多维表格的自定义插件中打开', 'error');
  }
}

refreshButton.addEventListener('click', () => {
  void loadTables();
});

addRecordButton.addEventListener('click', async () => {
  const tableId = tableSelect.value;
  if (!tableId) return;

  addRecordButton.disabled = true;
  setStatus('正在写入空白测试记录…', 'loading');

  try {
    const table = await bitable.base.getTableById(tableId);
    const recordId = await table.addRecord({ fields: {} });
    console.info('Test record created:', recordId);
    setStatus('写入成功：已新增一条空白记录', 'success');
  } catch (error) {
    console.error('Failed to create test record:', error);
    setStatus('写入失败：' + errorMessage(error), 'error');
  } finally {
    addRecordButton.disabled = false;
  }
});

void loadTables();
