import React, { useCallback, useEffect, useRef, useState } from 'react';
import Paper from '@material-ui/core/Paper';
import { MenuActions } from '../../constants';
import computeColumnWidths from './computeColumnWidths';
import sendMessage from '../../../../lib/messages';
import { UIAction } from '../../../Settings/actions';
import { clipboardInsert } from '../../../../lib/utils';
import QueryError from '../QueryError';
import { MenuProvider } from '../../context/MenuContext';
import useCurrentResult from '../../hooks/useCurrentResult';
import { NSDatabase } from '@sqltools/types';
import 'tabulator-tables/dist/css/tabulator.css';
import style from './style.m.scss';

const tabulatorModule = require('tabulator-tables');
const Tabulator = tabulatorModule.default || tabulatorModule.TabulatorFull || tabulatorModule;

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
  const mapped = columnMeta.filter(column => column.sourceColumn);
  if (!mapped.length || !rows.length) return '';
  const relation = [mapped[0].schema, mapped[0].table].filter(Boolean).map(quoteIdentifier).join('.');
  const columnNames = mapped.map(column => quoteIdentifier(column.sourceColumn)).join(', ');
  return rows.map(row => `INSERT INTO ${relation} (${columnNames}) VALUES (${mapped.map(column => formatSqlValue(row[column.name])).join(', ')});`).join('\n');
}

function rowsToUpdateStatements(rows: any[], columnMeta: NSDatabase.IResultColumnMeta[], selectedColumnNames: string[]): string {
  const mapped = columnMeta.filter(column => column.sourceColumn);
  if (!mapped.length || !rows.length) return '';
  const relation = [mapped[0].schema, mapped[0].table].filter(Boolean).map(quoteIdentifier).join('.');
  const pkColumns = mapped.filter(column => column.isPk);
  // no primary key: every mapped column is used to locate the row instead, matching the Save behavior
  const whereColumns = pkColumns.length ? pkColumns : mapped;
  const selected = mapped.filter(column => selectedColumnNames.includes(column.name));
  const setColumns = (selected.length ? selected : mapped).filter(column => !pkColumns.includes(column));
  return rows.map(row => {
    const setClause = (setColumns.length ? setColumns : mapped).map(column => `${quoteIdentifier(column.sourceColumn)} = ${formatSqlValue(row[column.name])}`).join(', ');
    const whereClause = whereColumns.map(column => `${quoteIdentifier(column.sourceColumn)} = ${formatSqlValue(row[column.name])}`).join(' AND ');
    return `UPDATE ${relation} SET ${setClause} WHERE ${whereClause};`;
  }).join('\n');
}

const displayValue = (value: any) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

const Table = ({ setContextState }) => {
  const tableElementRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<any>(null);
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
  const { results: rows = [], cols = [], error, messages = [], page, pageSize, total, queryType, queryParams, requestId, columnMeta = [], editable, nonEditableReason } = result || {};
  // without a primary key, every mapped column's original value is used to locate the row on save
  const hasPrimaryKey = columnMeta.some(column => column.isPk);

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
    if (cell.getValue() === oldValue) {
      pendingEditsRef.current.delete(key);
      cell.getElement().classList.remove(style.dirtyCell);
    } else {
      pendingEditsRef.current.set(key, { rowindex, colname, oldValue, newValue: cell.getValue() });
      cell.getElement().classList.add(style.dirtyCell);
    }
    setPendingEditCount(pendingEditsRef.current.size);
  }, [rows]);

  const changePage = useCallback((nextPage: number) => {
    setContextState({ loading: true });
    sendMessage(UIAction.CALL, {
      command: `${process.env.EXT_NAMESPACE}.${queryType}`,
      args: [queryParams, { page: nextPage, pageSize: pageSize ?? 50, requestId }],
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

  const onMenuOpen = useCallback(({ rowindex, colname }) => {
    const index = Number(rowindex);
    if (Number.isNaN(index) || index < 0) return;
    if (colname) activeCellRef.current = { rowindex: index, colname };
    // a right-click landing inside the already-selected range/row(s) must not collapse it down
    // to just the clicked cell - only move the range when clicking outside the current selection
    const ranges = tableRef.current?.getRanges?.() || [];
    const activeRange = ranges[ranges.length - 1];
    const rangeRowIndexes = activeRange ? activeRange.getRows().map(row => rows.indexOf(row.getData())).filter(i => i >= 0) : [];
    const rangeCols = activeRange ? activeRange.getColumns().map(column => column.getField()).filter(Boolean) : [];
    const clickIsInsideRange = activeRange && rangeRowIndexes.includes(index) && (!colname || rangeCols.includes(colname));
    if (clickIsInsideRange) {
      if (!selection.includes(index)) setSelection(rangeRowIndexes);
      return;
    }
    // replace the selection with the newly targeted row, unless it's already part of an existing multi-row selection
    if (!selection.includes(index)) setSelection([index]);
    // right-clicking a cell outside the current Tabulator range doesn't move that range on its own -
    // move it here so the visual selection and getRanges() both reflect the cell the menu will act on
    if (colname && tableRef.current) {
      const rowComponent = tableRef.current.getRows().find(row => row.getData() === rows[index]);
      const cell = rowComponent?.getCell(colname);
      if (cell) tableRef.current.addRange(cell);
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
    const value = (rows[index] || {})[colname];
    switch (choice) {
      case MenuActions.FilterByValueOption:
        tableRef.current?.setFilter(colname, '=', value);
        setHasFilters(true);
        return setSelection([]);
      case MenuActions.CopyCellOption: return clipboardInsert(value);
      case MenuActions.CopyColumnName: return clipboardInsert(colname);
      case MenuActions.CopyColumnNames: return clipboardInsert(cols.join(', '));
      case MenuActions.CopySelectedCSV: return clipboardInsert(rowsToCSV(selectedRows, exportCols));
      case MenuActions.CopySelectedJSON: {
        const projected = selectedRows.map(row => exportCols.reduce((acc, column) => { acc[column] = row[column]; return acc; }, {} as any));
        return clipboardInsert(JSON.stringify(projected.length === 1 ? projected[0] : projected, null, 2));
      }
      case MenuActions.CopyAsInsert: return clipboardInsert(rowsToInsertStatements(selectedRows, columnMeta));
      case MenuActions.CopyAsUpdate: return clipboardInsert(rowsToUpdateStatements(selectedRows, columnMeta, exportCols));
      case MenuActions.ClearFiltersOption:
        tableRef.current?.clearFilter();
        setHasFilters(false);
        return setSelection([]);
    }
  }, [cols, columnMeta, rows, selection, selectedColumns]);

  useEffect(() => {
    if (!tableElementRef.current || error || !result) return undefined;
    const widths = computeColumnWidths(cols, rows);
    const table = new Tabulator(tableElementRef.current, {
      data: rows,
      columns: cols.map(column => {
        const metadata = columnMeta.find(item => item.name === column);
        return {
          title: column,
          field: column,
          width: widths[column],
          headerSort: true,
          formatter: cell => displayValue(cell.getValue()),
          editor: editable && metadata?.editable ? 'input' : false,
          editorParams: { selectContents: true },
          cellEdited: cell => applyEditToCell(cell, column),
        };
      }),
      layout: 'fitDataFill',
      height: '100%',
      rowHeader: { formatter: 'rownum', width: 46, frozen: true, hozAlign: 'center', headerSort: false },
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeAutoFocus: true,
      // Tabulator defaults to starting edit mode on cell *focus*, which fires as soon as a
      // cell is selected/dragged for ranging - explicit dblclick trigger matches Excel behavior
      editTriggerEvent: 'dblclick',
      // copy/paste are both handled manually below (own clipboard event + keyboard shortcuts);
      // Tabulator's built-in clipboard module would otherwise run its own paste-as-insert
      // handler in parallel and insert phantom rows from the same clipboard event
      clipboard: false,
      headerSortClickElement: 'icon',
      cellMouseDown: (_event, cell) => {
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
      cellContext: (_event, cell) => {
        const element = cell.getElement();
        const colname = cell.getColumn().getField();
        element.dataset.rowindex = String(rows.indexOf(cell.getRow().getData()));
        if (colname) {
          element.dataset.colname = colname;
        } else {
          delete element.dataset.colname;
        }
      },
      headerContext: (_event, column) => {
        const element = column.getElement();
        const colname = column.getField();
        if (colname) {
          element.dataset.colname = colname;
        } else {
          delete element.dataset.colname;
        }
      },
      rowFormatter: row => {
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
      rangeAdded: range => {
        const rowIndexes = range.getRows().map(row => rows.indexOf(row.getData()));
        setSelection(rowIndexes.filter(index => index >= 0));
        setSelectedColumns(range.getColumns().map(column => column.getField()).filter(Boolean));
      },
      rangeRemoved: () => { setSelection([]); setSelectedColumns([]); },
    });
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
    return () => { table.destroy(); tableRef.current = null; };
  }, [cols, columnMeta, editable, error, result, rows]);

  // reads the live Tabulator range (falling back to prior selection state) for keyboard export shortcuts
  const getRangeExport = useCallback(() => {
    const ranges = tableRef.current?.getRanges?.() || [];
    const activeRange = ranges[ranges.length - 1];
    const rangeRowIndexes = activeRange ? activeRange.getRows().map(row => rows.indexOf(row.getData())).filter(i => i >= 0) : [];
    const rangeCols = activeRange ? activeRange.getColumns().map(column => column.getField()).filter(Boolean) : [];
    const indexes = rangeRowIndexes.length ? rangeRowIndexes : selection;
    const exportCols = rangeCols.length ? rangeCols : selectedColumns.length ? selectedColumns : cols;
    const selectedRows = indexes.map(rowIndex => rows[rowIndex]).filter(Boolean);
    return { selectedRows, exportCols };
  }, [rows, cols, selection, selectedColumns]);

  const selectAllCells = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const rowComponents = table.getRows();
    const columnComponents = table.getColumns().filter(column => column.getField());
    if (!rowComponents.length || !columnComponents.length) return;
    const firstCell = rowComponents[0].getCell(columnComponents[0].getField());
    const lastCell = rowComponents[rowComponents.length - 1].getCell(columnComponents[columnComponents.length - 1].getField());
    if (firstCell && lastCell) table.addRange(firstCell, lastCell);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches('input, textarea')) return;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        tableRef.current?.clearCellSelection();
        setSelection([]);
      } else if ((event.ctrlKey || event.metaKey) && key === 'a') {
        event.preventDefault();
        selectAllCells();
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'c') {
        event.preventDefault();
        const { selectedRows, exportCols } = getRangeExport();
        if (!selectedRows.length || !exportCols.length) return;
        const projected = selectedRows.map(row => exportCols.reduce((acc, column) => { acc[column] = row[column]; return acc; }, {} as any));
        clipboardInsert(JSON.stringify(projected.length === 1 ? projected[0] : projected, null, 2));
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'c' && !window.getSelection()?.toString()) {
        event.preventDefault();
        const { selectedRows, exportCols } = getRangeExport();
        if (selectedRows.length === 1 && exportCols.length === 1) {
          clipboardInsert(selectedRows[0][exportCols[0]]);
        } else if (selectedRows.length && exportCols.length) {
          clipboardInsert(rowsToTSV(selectedRows, exportCols));
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

      let targetRows: any[];
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
        if (cell && cell.getValue() !== value) {
          cell.setValue(value);
          applyEditToCell(cell, field);
        }
      };

      if (grid.length === 1 && grid[0].length === 1 && (targetRows.length > 1 || targetCols.length > 1)) {
        // pasting a single value over a multi-cell selection fills every cell, matching Excel's fill behavior
        const value = grid[0][0];
        targetRows.forEach(row => targetCols.forEach(field => writeCell(row, field, value)));
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

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('paste', onPaste);
    };
  }, [rows, cols, columnMeta, editable, getRangeExport, selectAllCells, applyEditToCell]);

  if (!result) return null;
  return (
    <MenuProvider onOpen={onMenuOpen} getOptions={getMenuOptions} onSelect={onMenuSelect}>
      <Paper square elevation={0} className={`result ${style.tabulatorContainer}`}>
        {error ? <QueryError messages={messages} /> : <div ref={tableElementRef} className={style.tabulator} />}
        {!error && !editable && nonEditableReason && <div className={style.readOnlyNotice}>{nonEditableReason}</div>}
        {pendingEditCount > 0 && <div className={style.editToolbar}>
          <span>{pendingEditCount} unsaved change{pendingEditCount === 1 ? '' : 's'}</span>
          {editable && !hasPrimaryKey && <span className={style.noPkWarning}>No primary key set on this table - updates will match rows using all columns.</span>}
          {saveError && <span className={style.saveError}>{saveError}</span>}
          <button type="button" disabled={saving} onClick={cancelEdits}>Cancel</button>
          <button type="button" disabled={saving} onClick={saveEdits}>{saving ? 'Saving...' : 'Save'}</button>
        </div>}
        {typeof page === 'number' && total > (pageSize ?? 50) && <div className={style.pagination}>
          <button type="button" disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</button>
          <span>{page + 1}</span>
          <button type="button" disabled={(page + 1) * (pageSize ?? 50) >= total} onClick={() => changePage(page + 1)}>Next</button>
        </div>}
      </Paper>
    </MenuProvider>
  );
};

export default Table;
