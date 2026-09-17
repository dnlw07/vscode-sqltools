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

const displayValue = (value: any) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

const Table = ({ setContextState }) => {
  const tableElementRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<any>(null);
  const activeCellRef = useRef<{ rowindex: number; colname: string } | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [hasFilters, setHasFilters] = useState(false);
  const { result } = useCurrentResult();
  const { results: rows = [], cols = [], error, messages = [], page, pageSize, total, queryType, queryParams, requestId } = result || {};

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

    const miscGroup: any[] = [];
    if (hasFilters) miscGroup.push(MenuActions.ClearFiltersOption);
    if (indexes.length > 1) miscGroup.push(MenuActions.ClearSelection);
    if (miscGroup.length) groups.push(miscGroup);

    const options: any[] = [];
    groups.forEach((group, i) => {
      if (i > 0) options.push(MenuActions.Divider);
      options.push(...group);
    });
    return options;
  }, [cols, hasFilters, rows, selection]);

  const onMenuOpen = useCallback(({ rowindex, colname }) => {
    const index = Number(rowindex);
    if (Number.isNaN(index) || index < 0) return;
    if (colname) activeCellRef.current = { rowindex: index, colname };
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
      case MenuActions.ClearFiltersOption:
        tableRef.current?.clearFilter();
        setHasFilters(false);
        return setSelection([]);
      case MenuActions.ClearSelection:
        tableRef.current?.clearCellSelection();
        return setSelection([]);
    }
  }, [cols, rows, selection, selectedColumns]);

  useEffect(() => {
    if (!tableElementRef.current || error || !result) return undefined;
    const widths = computeColumnWidths(cols, rows);
    const table = new Tabulator(tableElementRef.current, {
      data: rows,
      columns: cols.map(column => ({ title: column, field: column, width: widths[column], headerSort: true, formatter: cell => displayValue(cell.getValue()) })),
      layout: 'fitDataFill',
      height: '100%',
      rowHeader: { formatter: 'rownum', width: 46, frozen: true, hozAlign: 'center', headerSort: false },
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeAutoFocus: true,
      clipboard: true,
      clipboardCopyRowRange: 'range',
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
    tableRef.current = table;
    return () => { table.destroy(); tableRef.current = null; };
  }, [cols, error, result, rows]);

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
          clipboardInsert(rowsToCSV(selectedRows, exportCols));
        } else if (activeCellRef.current) {
          const active = activeCellRef.current;
          clipboardInsert(rows[active.rowindex]?.[active.colname]);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [rows, getRangeExport, selectAllCells]);

  if (!result) return null;
  return (
    <MenuProvider onOpen={onMenuOpen} getOptions={getMenuOptions} onSelect={onMenuSelect}>
      <Paper square elevation={0} className={`result ${style.tabulatorContainer}`}>
        {error ? <QueryError messages={messages} /> : <div ref={tableElementRef} className={style.tabulator} />}
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
