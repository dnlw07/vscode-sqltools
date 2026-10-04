import React, { useCallback, useEffect, useRef, useState } from 'react';
import Paper from '@material-ui/core/Paper';
import flatten from 'lodash/flatten';
import { MenuActions } from '../../constants';
import computeColumnWidths from './computeColumnWidths';
import sendMessage from '../../../../lib/messages';
import { UIAction } from '../../../Settings/actions';
import { clipboardInsert } from '../../../../lib/utils';
import QueryError from '../QueryError';
import { MenuProvider } from '../../context/MenuContext';
import useCurrentResult from '../../hooks/useCurrentResult';
import { NSDatabase } from '@sqltools/types';
import type { CellComponent, ColumnComponent, ColumnDefinition, Editor, RowComponent, TabulatorFull } from 'tabulator-tables';
import { ResultsScreenState } from '../../interfaces';
import { normalizeEditedValue } from './normalizeEditedValue';
import 'tabulator-tables/dist/css/tabulator.css';
import style from './style.m.scss';

const tabulatorModule = require('tabulator-tables');
const Tabulator = tabulatorModule.default || tabulatorModule.TabulatorFull || tabulatorModule;
const EMPTY_ARRAY: any[] = [];

type GridTable = TabulatorFull;
type SourceColumn = NSDatabase.IResultColumnMeta & { sourceColumn: string };

const hasSourceColumn = (column: NSDatabase.IResultColumnMeta): column is SourceColumn => !!column.sourceColumn;
const isIdentifier = (name: string | undefined): name is string => !!name;

function rowsToCSV(rows: any[], columns: string[]): string {
  if (!rows.length) return '';
  const escape = (value: any) => {
    const text = value == null ? '' : String(typeof value === 'object' ? JSON.stringify(value) : value);
    return /[,"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map(row => columns.map(column => escape(row[column])).join(','))].join('\n');
}

// Standard spreadsheet clipboard format (tab-separated, no header row) so a plain Ctrl+C/Ctrl+V
// round-trips correctly here and interoperates with Excel/Sheets/other grids.
function rowsToTSV(rows: any[], columns: string[]): string {
  const plain = (value: any) => {
    const text = value == null ? '' : String(typeof value === 'object' ? JSON.stringify(value) : value);
    return text.replace(/[\t\n]/g, ' ');
  };
  return rows.map(row => columns.map(column => plain(row[column])).join('\t')).join('\n');
}

function quoteIdentifier(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function formatSqlValue(value: any): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function rowsToInsertStatements(rows: any[], columnMeta: NSDatabase.IResultColumnMeta[]): string {
  const mapped = columnMeta.filter(hasSourceColumn);
  if (!mapped.length || !rows.length) return '';
  const relation = [mapped[0].schema, mapped[0].table].filter(isIdentifier).map(quoteIdentifier).join('.');
  const columnNames = mapped.map(column => quoteIdentifier(column.sourceColumn)).join(', ');
  return rows.map(row => `INSERT INTO ${relation} (${columnNames}) VALUES (${mapped.map(column => formatSqlValue(row[column.name])).join(', ')});`).join('\n');
}

function rowsToUpdateStatements(rows: any[], columnMeta: NSDatabase.IResultColumnMeta[], selectedColumnNames: string[]): string {
  const mapped = columnMeta.filter(hasSourceColumn);
  if (!mapped.length || !rows.length) return '';
  const relation = [mapped[0].schema, mapped[0].table].filter(isIdentifier).map(quoteIdentifier).join('.');
  const pkColumns = mapped.filter(column => column.isPk);
  // no primary key: every mapped column is used to locate the row instead, matching the Save behavior
  const whereColumns = pkColumns.length ? pkColumns : mapped;
  const setColumns = mapped.filter(column => selectedColumnNames.includes(column.name));
  if (!setColumns.length) return '';
  return rows.map(row => {
    const setClause = setColumns.map(column => `${quoteIdentifier(column.sourceColumn)} = ${formatSqlValue(row[column.name])}`).join(', ');
    const whereClause = whereColumns.map(column => `${quoteIdentifier(column.sourceColumn)} = ${formatSqlValue(row[column.name])}`).join(' AND ');
    return `UPDATE ${relation} SET ${setClause} WHERE ${whereClause};`;
  }).join('\n');
}

const displayValue = (value: any) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

const typedInputEditor: Extract<Editor, (...args: any[]) => any> = (cell, onRendered, success, cancel) => {
  const originalValue = cell.getValue();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = originalValue == null ? '' : String(originalValue);
  input.style.width = '100%';
  input.style.height = '100%';
  input.style.boxSizing = 'border-box';

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    success(normalizeEditedValue(input.value, originalValue));
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      settled = true;
      cancel(undefined);
    }
  });
  onRendered(() => {
    input.focus();
    input.select();
  });
  return input;
};

const Table = ({ setContextState }: { setContextState: (state: Partial<ResultsScreenState>) => void }) => {
  const tableElementRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<GridTable | null>(null);
  const activeCellRef = useRef<{ rowindex: number; colname: string } | null>(null);
  const pendingEditsRef = useRef(new Map<string, { rowindex: number; colname: string; oldValue: any; newValue: any }>());
  const editingRef = useRef(false);
  const [selection, setSelection] = useState<number[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [hasFilters, setHasFilters] = useState(false);
  const [pendingEditCount, setPendingEditCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { result } = useCurrentResult();
  const { results: rows = EMPTY_ARRAY, cols = EMPTY_ARRAY, error, messages = EMPTY_ARRAY, page, pageSize, total = 0, queryType, queryParams, requestId, columnMeta = EMPTY_ARRAY, editable, nonEditableReason } = result || {};
  // without a primary key, every mapped column's original value is used to locate the row on save
  const hasPrimaryKey = columnMeta.some(column => column.isPk);
  const hasPendingPrimaryKeyEdit = [...pendingEditsRef.current.values()].some(edit => columnMeta.some(column => column.name === edit.colname && column.isPk));

  const cancelEdits = useCallback(() => {
    pendingEditsRef.current.forEach(edit => {
      const cell = tableRef.current?.getRows()?.[edit.rowindex]?.getCell(edit.colname);
      cell?.setValue(edit.oldValue, true);
      cell?.getElement().classList.remove(style.dirtyCell);
    });
    pendingEditsRef.current.clear();
    setPendingEditCount(0);
    setSaveError(null);
  }, []);

  const saveEdits = useCallback(() => {
    if (saving || !pendingEditsRef.current.size || !editable) return;
    // group first: Tabulator mutates row data in place on edit, so by the time Save runs every
    // edited cell's *new* value is already sitting in `rows` - the match condition must instead
    // use each edited column's tracked pre-edit value, not the (already mutated) live row value
    const editsByRowIndex = new Map<number, Map<string, { oldValue: any; newValue: any }>>();
    pendingEditsRef.current.forEach(edit => {
      const rowEdits = editsByRowIndex.get(edit.rowindex) || new Map();
      rowEdits.set(edit.colname, edit);
      editsByRowIndex.set(edit.rowindex, rowEdits);
    });
    const editsByRow = new Map<number, NSDatabase.IResultEdit>();
    editsByRowIndex.forEach((colEdits, rowindex) => {
      const row = rows[rowindex];
      const firstSource = columnMeta.find(column => colEdits.has(column.name));
      if (!firstSource?.table || !firstSource.schema) return;
      const matchColumns = hasPrimaryKey ? columnMeta.filter(column => column.isPk) : columnMeta.filter(column => column.sourceColumn);
      const primaryKey = matchColumns.reduce((values, column) => {
        if (!column.sourceColumn) return values;
        const pending = colEdits.get(column.name);
        values[column.sourceColumn] = pending ? pending.oldValue : row[column.name];
        return values;
      }, {} as any);
      const changes = {} as any;
      colEdits.forEach((edit, colname) => {
        const source = columnMeta.find(column => column.name === colname);
        if (source?.sourceColumn) changes[source.sourceColumn] = edit.newValue;
      });
      editsByRow.set(rowindex, { table: { label: firstSource.table, schema: firstSource.schema }, primaryKey, changes });
    });
    const correlationId = `${Date.now()}-${Math.random()}`;
    const receiveResult = (event: MessageEvent) => {
      if (event.data?.action !== UIAction.CALL_RESULT || event.data?.payload?.correlationId !== correlationId) return;
      window.removeEventListener('message', receiveResult);
      const response = event.data.payload.result;
      setSaving(false);
      if (!response?.success) return setSaveError(response?.error || 'Unable to save changes.');
      pendingEditsRef.current.forEach(edit => tableRef.current?.getRows()?.[edit.rowindex]?.getCell(edit.colname)?.getElement().classList.remove(style.dirtyCell));
      pendingEditsRef.current.clear();
      setPendingEditCount(0);
      setSaveError(null);
    };
    window.addEventListener('message', receiveResult);
    setSaving(true);
    setSaveError(null);
    sendMessage(UIAction.CALL, { command: `${process.env.EXT_NAMESPACE}.applyResultEdits`, args: [[...editsByRow.values()], { requestId }], correlationId });
  }, [columnMeta, editable, hasPrimaryKey, requestId, rows, saving]);

  // shared bookkeeping for both interactive edits and programmatic (paste) value changes
  const applyEditToCell = useCallback((cell: any, colname: string) => {
    const rowindex = rows.indexOf(cell.getRow().getData());
    const key = `${rowindex}:${colname}`;
    const existing = pendingEditsRef.current.get(key);
    const oldValue = existing ? existing.oldValue : cell.getOldValue();
    const newValue = normalizeEditedValue(cell.getValue(), oldValue);
    if (newValue === oldValue) {
      pendingEditsRef.current.delete(key);
      cell.getElement().classList.remove(style.dirtyCell);
    } else {
      pendingEditsRef.current.set(key, { rowindex, colname, oldValue, newValue });
      cell.getElement().classList.add(style.dirtyCell);
    }
    setPendingEditCount(pendingEditsRef.current.size);
  }, [rows]);

  const changePage = useCallback((nextPage: number) => {
    setContextState({ loading: true });
    sendMessage(UIAction.CALL, {
      command: `${process.env.EXT_NAMESPACE}.${queryType}`,
      args: [queryParams, { page: nextPage, pageSize: pageSize ?? 100, requestId }],
    });
  }, [pageSize, queryParams, queryType, requestId, setContextState]);

  const getMenuOptions = useCallback(({ colname, rowindex }) => {
    const index = Number(rowindex);
    const row = rows[index];
    const indexes = selection.length ? selection : row ? [index] : [];
    const groups: any[][] = [];

    if (row && colname) {
      const value = row[colname];
      const objectValue = value !== null && typeof value === 'object';
      const label = objectValue ? 'Cell Value' : `'${value}'`;
      groups.push([{ label: MenuActions.CopyCellOption.replace('{contextAction}', label), value: MenuActions.CopyCellOption }]);
      if (typeof value !== 'undefined' && !objectValue) {
        groups.push([{ label: MenuActions.FilterByValueOption.replace('{contextAction}', label), value: MenuActions.FilterByValueOption }]);
      }
    }

    const columnNameGroup: any[] = [];
    if (colname) columnNameGroup.push(MenuActions.CopyColumnName);
    if (cols.length) columnNameGroup.push(MenuActions.CopyColumnNames);
    if (columnNameGroup.length) groups.push(columnNameGroup);

    if (indexes.length) groups.push([MenuActions.CopySelectedCSV, MenuActions.CopySelectedJSON]);

    // requires a resolved source table (from columnMeta) to know what to INSERT INTO / UPDATE
    if (indexes.length && columnMeta.some(column => column.table)) {
      groups.push([MenuActions.CopyAsInsert, MenuActions.CopyAsUpdate]);
    }

    const miscGroup: any[] = [];
    if (hasFilters) miscGroup.push(MenuActions.ClearFiltersOption);
    if (miscGroup.length) groups.push(miscGroup);

    const options: any[] = [];
    groups.forEach((group, i) => {
      if (i > 0) options.push(MenuActions.Divider);
      options.push(...group);
    });
    return options;
  }, [cols, columnMeta, hasFilters, rows, selection]);

  const getSelectedBlocks = useCallback(() => {
    const blocks = (tableRef.current?.getRanges() || []).map(range => ({
      selectedRows: range.getRows().map(row => row.getData()),
      exportCols: range.getColumns().map(column => column.getField()).filter(Boolean),
    })).filter(block => block.selectedRows.length && block.exportCols.length);
    const merged: typeof blocks = [];
    const columnOrder = (tableRef.current?.getColumns() || []).map(column => column.getField()).filter(Boolean);
    blocks.forEach(block => {
      const matching = merged.find(existing => existing.selectedRows.length === block.selectedRows.length &&
        existing.selectedRows.every((row, index) => row === block.selectedRows[index]));
      if (matching) {
        matching.exportCols = columnOrder.filter(column => matching.exportCols.includes(column) || block.exportCols.includes(column));
      } else {
        merged.push({ ...block, exportCols: columnOrder.filter(column => block.exportCols.includes(column)) });
      }
    });
    return merged;
  }, []);

  const onMenuOpen = useCallback(({ rowindex, colname }) => {
    const index = Number(rowindex);
    if (Number.isNaN(index) || index < 0) return;
    if (colname) activeCellRef.current = { rowindex: index, colname };
    // a right-click landing inside the already-selected range/row(s) must not collapse it down
    // to just the clicked cell - only move the range when clicking outside the current selection
    const ranges = tableRef.current?.getRanges?.() || [];
    const clickIsInsideRange = ranges.some(range =>
      range.getRows().some(row => row.getData() === rows[index]) &&
      (!colname || range.getColumns().some(column => column.getField() === colname)),
    );
    if (clickIsInsideRange) {
      return;
    }
    // replace the selection with the newly targeted row, unless it's already part of an existing multi-row selection
    if (!selection.includes(index)) setSelection([index]);
    // right-clicking a cell outside the current Tabulator range doesn't move that range on its own -
    // move it here so the visual selection and getRanges() both reflect the cell the menu will act on
    if (colname && tableRef.current) {
      const rowComponent = tableRef.current.getRows().find(row => row.getData() === rows[index]);
      const cell = rowComponent?.getCell(colname);
      if (cell) {
        const ranges = tableRef.current.getRanges();
        if (ranges.length) {
          ranges.slice(1).forEach(range => range.remove());
          ranges[0].setBounds(cell, cell);
        } else {
          tableRef.current.addRange(cell, cell);
        }
      }
    }
  }, [selection, rows]);

  const onMenuSelect = useCallback((choice: string, { rowindex, colname }) => {
    const index = Number(rowindex);
    // read the live range straight from Tabulator, since React state can lag behind
    // a selection made by clicking a column/row header just before opening the menu
    const ranges = tableRef.current?.getRanges?.() || [];
    const activeRange = ranges[ranges.length - 1];
    const rangeRowIndexes = activeRange ? activeRange.getRows().map(row => rows.indexOf(row.getData())).filter(i => i >= 0) : [];
    const rangeCols = activeRange ? activeRange.getColumns().map(column => column.getField()).filter(Boolean) : [];
    // a right-click on a cell outside the current Tabulator range doesn't move that range - in that
    // case the freshly clicked cell (not the stale range) is the one the user means to act on
    const clickIsInsideRange = activeRange && rangeRowIndexes.includes(index) && (!colname || rangeCols.includes(colname));
    const indexes = clickIsInsideRange ? rangeRowIndexes : selection.includes(index) ? selection : [index];
    const selectedRows = indexes.map(rowIndex => rows[rowIndex]).filter(Boolean);
    const exportCols = clickIsInsideRange ? rangeCols : colname ? [colname] : selectedColumns.length ? selectedColumns : cols;
    const blocks = getSelectedBlocks();
    const exportBlocks = blocks.length ? blocks : [{ selectedRows, exportCols }];
    const value = (rows[index] || {})[colname];
    switch (choice) {
      case MenuActions.FilterByValueOption:
        tableRef.current?.setFilter(colname, '=', value);
        setHasFilters(true);
        return setSelection([]);
      case MenuActions.CopyCellOption: return clipboardInsert(value);
      case MenuActions.CopyColumnName: return clipboardInsert(colname);
      case MenuActions.CopyColumnNames: return clipboardInsert(cols.join(', '));
      case MenuActions.CopySelectedCSV: return clipboardInsert(exportBlocks.map(block => rowsToCSV(block.selectedRows, block.exportCols)).join('\n'));
      case MenuActions.CopySelectedJSON: {
        const projected = flatten(exportBlocks.map(block => block.selectedRows.map(row => block.exportCols.reduce((acc, column) => { acc[column] = row[column]; return acc; }, {} as any))));
        return clipboardInsert(JSON.stringify(projected.length === 1 ? projected[0] : projected, null, 2));
      }
      case MenuActions.CopyAsInsert: return clipboardInsert(rowsToInsertStatements([...new Set(flatten(exportBlocks.map(block => block.selectedRows)))], columnMeta));
      case MenuActions.CopyAsUpdate: return clipboardInsert(exportBlocks.map(block => rowsToUpdateStatements(block.selectedRows, columnMeta, block.exportCols)).join('\n'));
      case MenuActions.ClearFiltersOption:
        tableRef.current?.clearFilter(false);
        setHasFilters(false);
        return setSelection([]);
    }
  }, [cols, columnMeta, rows, selection, selectedColumns, getSelectedBlocks]);

  useEffect(() => {
    if (!tableElementRef.current || error || !result) return undefined;
    const widths = computeColumnWidths(cols, rows);
    const table: GridTable = new Tabulator(tableElementRef.current, {
      data: rows,
      columns: cols.map((column): ColumnDefinition => {
        const metadata = columnMeta.find(item => item.name === column);
        return {
          title: column,
          field: column,
          width: widths[column],
          headerSort: true,
          formatter: cell => displayValue(cell.getValue()),
          editor: editable && metadata?.editable ? typedInputEditor : undefined,
          cellEdited: cell => applyEditToCell(cell, column),
        };
      }),
      layout: 'fitDataFill',
      height: '100%',
      rowHeader: { formatter: 'rownum', width: 46, frozen: true, hozAlign: 'center', headerSort: false },
      selectableRange: true,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      // auto-focusing the default range on build pulls VS Code focus from the editor into the webview
      selectableRangeAutoFocus: false,
      // Tabulator defaults to starting edit mode on cell *focus*, which fires as soon as a
      // cell is selected/dragged for ranging - explicit dblclick trigger matches Excel behavior
      editTriggerEvent: 'dblclick',
      // copy/paste are both handled manually below (own clipboard event + keyboard shortcuts);
      // Tabulator's built-in clipboard module would otherwise run its own paste-as-insert
      // handler in parallel and insert phantom rows from the same clipboard event
      clipboard: false,
      headerSortClickElement: 'icon',
      cellMouseDown: (_event: MouseEvent, cell: CellComponent) => {
        const rowindex = rows.indexOf(cell.getRow().getData());
        const colname = cell.getColumn().getField();
        cell.getElement().dataset.rowindex = String(rowindex);
        if (colname) {
          activeCellRef.current = { rowindex, colname };
          cell.getElement().dataset.colname = colname;
        } else {
          delete cell.getElement().dataset.colname;
        }
      },
      cellContext: (_event: MouseEvent, cell: CellComponent) => {
        const element = cell.getElement();
        const colname = cell.getColumn().getField();
        element.dataset.rowindex = String(rows.indexOf(cell.getRow().getData()));
        if (colname) {
          element.dataset.colname = colname;
        } else {
          delete element.dataset.colname;
        }
      },
      headerContext: (_event: MouseEvent, column: ColumnComponent) => {
        const element = column.getElement();
        const colname = column.getField();
        if (colname) {
          element.dataset.colname = colname;
        } else {
          delete element.dataset.colname;
        }
      },
      rowFormatter: (row: RowComponent) => {
        // dataset must be set at render time, not only on click, so the first right-click on any cell already has full context
        const rowindex = String(rows.indexOf(row.getData()));
        const rowHeader = row.getElement().querySelector('.tabulator-row-header') as HTMLElement;
        if (rowHeader) rowHeader.dataset.rowindex = rowindex;
        row.getCells().forEach(cell => {
          const field = cell.getColumn().getField();
          if (!field) return; // skip the row-header pseudo-column, it has no field and must not carry a colname
          const element = cell.getElement();
          element.dataset.rowindex = rowindex;
          element.dataset.colname = field;
        });
      },
    });
    const syncSelection = () => {
      const ranges = table.getRanges();
      setSelection([...new Set(flatten(ranges.map(range => range.getRows().map(row => rows.indexOf(row.getData())))))].filter(index => index >= 0));
      setSelectedColumns([...new Set(flatten(ranges.map(range => range.getColumns().map(column => column.getField()))))].filter(Boolean));
    };
    table.on('rangeAdded', syncSelection);
    table.on('rangeChanged', syncSelection);
    table.on('rangeRemoved', syncSelection);
    const gridElement = tableElementRef.current;
    const preserveContextSelection = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const target = event.target as HTMLElement;
      const cell = target.closest<HTMLElement>('.tabulator-cell');
      const rowindex = cell?.dataset.rowindex;
      const colname = cell?.dataset.colname;
      const selected = table.getRanges().some(range => cell
        ? rowindex !== undefined && range.getRows().some(row => row.getData() === rows[Number(rowindex)]) &&
          (!colname || range.getColumns().some(column => column.getField() === colname))
        : range.getColumns().some(column => column.getElement().contains(target)),
      );
      if (selected) event.stopPropagation();
    };
    gridElement.addEventListener('mousedown', preserveContextSelection, true);
    // dataset must be set at render time, not only reactively on the headerContext event,
    // since that event has proven unreliable for the very first right-click on a header
    table.on('tableBuilt', () => {
      table.getColumns().forEach(column => {
        const field = column.getField();
        if (field) column.getElement().dataset.colname = field;
      });
    });
    // tracked so a printable keystroke on a selected (non-editing) cell knows whether to start an overwrite edit
    table.on('cellEditing', () => { editingRef.current = true; });
    table.on('cellEdited', () => { editingRef.current = false; });
    table.on('cellEditCancelled', () => { editingRef.current = false; });
    tableRef.current = table;
    return () => {
      gridElement.removeEventListener('mousedown', preserveContextSelection, true);
      table.destroy();
      tableRef.current = null;
    };
  }, [cols, columnMeta, editable, error, result, rows]);

  const selectAllCells = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const rowComponents = table.getRows('active');
    const columnComponents = table.getColumns().filter(column => column.getField());
    if (!rowComponents.length || !columnComponents.length) return;
    const firstCell = rowComponents[0].getCell(columnComponents[0].getField());
    const lastCell = rowComponents[rowComponents.length - 1].getCell(columnComponents[columnComponents.length - 1].getField());
    if (firstCell && lastCell) {
      const ranges = table.getRanges();
      if (ranges.length) {
        ranges.slice(1).forEach(range => range.remove());
        ranges[0].setBounds(firstCell, lastCell);
      } else {
        table.addRange(firstCell, lastCell);
      }
    }
  }, []);

  useEffect(() => {
    const onSelectAll = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'a') return;
      if (!tableElementRef.current?.contains(target)) return;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      selectAllCells();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches('input, textarea')) return;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        tableRef.current?.getRanges().forEach(range => range.remove());
        setSelection([]);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'c') {
        event.preventDefault();
        const blocks = getSelectedBlocks();
        if (!blocks.length) return;
        const projected = flatten(blocks.map(block => block.selectedRows.map(row => block.exportCols.reduce((acc, column) => { acc[column] = row[column]; return acc; }, {} as any))));
        clipboardInsert(JSON.stringify(projected.length === 1 ? projected[0] : projected, null, 2));
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'c' && !window.getSelection()?.toString()) {
        event.preventDefault();
        const blocks = getSelectedBlocks();
        if (blocks.length === 1 && blocks[0].selectedRows.length === 1 && blocks[0].exportCols.length === 1) {
          clipboardInsert(blocks[0].selectedRows[0][blocks[0].exportCols[0]]);
        } else if (blocks.length) {
          clipboardInsert(blocks.map(block => rowsToTSV(block.selectedRows, block.exportCols)).join('\n'));
        } else if (activeCellRef.current) {
          const active = activeCellRef.current;
          clipboardInsert(rows[active.rowindex]?.[active.colname]);
        }
      } else if (!editingRef.current && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && activeCellRef.current) {
        // Excel-like overwrite: typing on a selected, non-editing cell replaces its content instead of appending to it
        const { rowindex, colname } = activeCellRef.current;
        if (!editable || !columnMeta.find(column => column.name === colname)?.editable) return;
        const cell = tableRef.current?.getRows()?.[rowindex]?.getCell(colname);
        if (!cell) return;
        event.preventDefault();
        cell.edit(true);
        const input = cell.getElement().querySelector('input') as HTMLInputElement;
        if (input) {
          input.value = event.key;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      if ((event.target as HTMLElement)?.matches('input, textarea') || !editable || !tableRef.current) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      const lines = text.replace(/\r/g, '').split('\n');
      while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const grid = lines.map(line => line.split('\t'));
      if (!grid.length) return;

      const ranges = tableRef.current.getRanges?.() || [];
      const activeRange = ranges[ranges.length - 1];
      const rangeRows = activeRange ? activeRange.getRows() : [];
      const rangeCols = activeRange ? activeRange.getColumns().map(column => column.getField()).filter(Boolean) : [];
      const allRows = tableRef.current.getRows();

      let targetRows: RowComponent[];
      let targetCols: string[];
      if (rangeRows.length && rangeCols.length) {
        targetRows = rangeRows;
        targetCols = rangeCols;
      } else if (activeCellRef.current) {
        const row = allRows[activeCellRef.current.rowindex];
        targetRows = row ? [row] : [];
        targetCols = [activeCellRef.current.colname];
      } else {
        return;
      }
      if (!targetRows.length || !targetCols.length) return;
      event.preventDefault();

      const isEditableCol = (field: string) => columnMeta.find(column => column.name === field)?.editable;
      const writeCell = (row: any, field: string, value: string) => {
        if (!field || !isEditableCol(field)) return;
        const cell = row.getCell(field);
        const normalizedValue = cell && normalizeEditedValue(value, cell.getValue());
        if (cell && cell.getValue() !== normalizedValue) {
          cell.setValue(normalizedValue);
          applyEditToCell(cell, field);
        }
      };

      if (grid.length === 1 && grid[0].length === 1) {
        // pasting a single value over a multi-cell selection fills every cell, matching Excel's fill behavior
        const value = grid[0][0];
        if (ranges.length) {
          ranges.forEach(range => range.getRows().forEach(row => range.getColumns().forEach(column => writeCell(row, column.getField(), value))));
        } else {
          targetRows.forEach(row => targetCols.forEach(field => writeCell(row, field, value)));
        }
        return;
      }

      if (ranges.length > 1) {
        ranges.forEach(range => {
          const selectedRows = range.getRows();
          const selectedColumns = range.getColumns().filter(column => column.getField());
          grid.forEach((line, rowOffset) => {
            const row = selectedRows[rowOffset];
            if (!row) return;
            line.forEach((value, columnOffset) => {
              const column = selectedColumns[columnOffset];
              if (column) writeCell(row, column.getField(), value);
            });
          });
        });
        return;
      }

      const anchorRowIndex = allRows.indexOf(targetRows[0]);
      const anchorColIndex = cols.indexOf(targetCols[0]);
      grid.forEach((line, rOffset) => {
        const row = allRows[anchorRowIndex + rOffset];
        if (!row) return;
        line.forEach((value, cOffset) => writeCell(row, cols[anchorColIndex + cOffset], value));
      });
    };

    document.addEventListener('keydown', onSelectAll, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onSelectAll, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('paste', onPaste);
    };
  }, [rows, cols, columnMeta, editable, getSelectedBlocks, selectAllCells, applyEditToCell]);

  if (!result) return null;
  return (
    <MenuProvider onOpen={onMenuOpen} getOptions={getMenuOptions} onSelect={onMenuSelect}>
      <Paper square elevation={0} className={`result ${style.tabulatorContainer}`}>
        {error ? <QueryError messages={messages} /> : <div ref={tableElementRef} className={style.tabulator} />}
        {!error && !editable && nonEditableReason && <div className={style.readOnlyNotice}>{nonEditableReason}</div>}
        {pendingEditCount > 0 && <div className={style.editToolbar}>
          <span>{pendingEditCount} unsaved change{pendingEditCount === 1 ? '' : 's'}</span>
          {editable && !hasPrimaryKey && <span className={style.noPkWarning}>No primary key set on this table - updates will match rows using all columns.</span>}
          {hasPendingPrimaryKeyEdit && <span className={style.noPkWarning}>Primary key values are being changed. Ensure the new values are unique.</span>}
          {saveError && <span className={style.saveError}>{saveError}</span>}
          <button type="button" disabled={saving} onClick={cancelEdits}>Cancel</button>
          <button type="button" disabled={saving} onClick={saveEdits}>{saving ? 'Saving...' : 'Save'}</button>
        </div>}
        {typeof page === 'number' && total > (pageSize ?? 100) && <div className={style.pagination}>
          <button type="button" disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</button>
          <span>{page + 1}</span>
          <button type="button" disabled={(page + 1) * (pageSize ?? 100) >= total} onClick={() => changePage(page + 1)}>Next</button>
        </div>}
      </Paper>
    </MenuProvider>
  );
};

export default Table;
