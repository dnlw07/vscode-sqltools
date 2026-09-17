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
import useContextAction from '../../hooks/useContextAction';
import style from './style.m.scss';
import 'tabulator-tables/dist/css/tabulator.css';

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
  const [hasFilters, setHasFilters] = useState(false);
  const { exportResults } = useContextAction();
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
    const options: any[] = [];
    if (row) {
      const value = row[colname];
      const objectValue = value !== null && typeof value === 'object';
      const label = objectValue ? 'Cell Value' : `'${value}'`;
      options.push({ label: MenuActions.CopyCellOption.replace('{contextAction}', label), value: MenuActions.CopyCellOption });
      if (typeof value !== 'undefined' && !objectValue) options.push({ label: MenuActions.FilterByValueOption.replace('{contextAction}', label), value: MenuActions.FilterByValueOption });
      options.push(MenuActions.CopyColumnName);
    }
    if (cols.length) options.push(MenuActions.CopyColumnNames);
    if (indexes.length) options.push(MenuActions.CopySelectedCSV, MenuActions.CopySelectedJSON, MenuActions.SaveCSVOption, MenuActions.SaveJSONOption);
    if (hasFilters) options.push(MenuActions.ClearFiltersOption);
    if (indexes.length > 1) options.push(MenuActions.ClearSelection);
    return options;
  }, [cols, hasFilters, rows, selection]);

  const onMenuOpen = useCallback(({ rowindex, colname }) => {
    const index = Number(rowindex);
    if (Number.isNaN(index) || index < 0) return;
    if (colname) activeCellRef.current = { rowindex: index, colname };
    if (!selection.length) setSelection([index]);
  }, [selection.length]);

  const onMenuSelect = useCallback((choice: string, { rowindex, colname }) => {
    const index = Number(rowindex);
    const indexes = selection.length ? selection : [index];
    const selectedRows = indexes.map(rowIndex => rows[rowIndex]).filter(Boolean);
    const value = (rows[index] || {})[colname];
    switch (choice) {
      case MenuActions.FilterByValueOption:
        tableRef.current?.setFilter(colname, '=', value);
        setHasFilters(true);
        return setSelection([]);
      case MenuActions.CopyCellOption: return clipboardInsert(value);
      case MenuActions.CopyColumnName: return clipboardInsert(colname);
      case MenuActions.CopyColumnNames: return clipboardInsert(cols.join(', '));
      case MenuActions.CopySelectedCSV: return clipboardInsert(rowsToCSV(selectedRows, cols));
      case MenuActions.CopySelectedJSON: return clipboardInsert(JSON.stringify(selectedRows.length === 1 ? selectedRows[0] : selectedRows, null, 2));
      case MenuActions.ClearFiltersOption:
        tableRef.current?.clearFilter();
        setHasFilters(false);
        return setSelection([]);
      case MenuActions.ClearSelection:
        tableRef.current?.clearCellSelection();
        return setSelection([]);
      case MenuActions.SaveCSVOption:
      case MenuActions.SaveJSONOption: return exportResults(choice);
    }
  }, [cols, exportResults, rows, selection]);

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
        activeCellRef.current = { rowindex, colname };
        cell.getElement().dataset.rowindex = String(rowindex);
        cell.getElement().dataset.colname = colname;
      },
      cellContext: (_event, cell) => {
        const element = cell.getElement();
        element.dataset.rowindex = String(rows.indexOf(cell.getRow().getData()));
        element.dataset.colname = cell.getColumn().getField();
      },
      rowFormatter: row => {
        const rowHeader = row.getElement().querySelector('.tabulator-row-header') as HTMLElement;
        if (rowHeader) rowHeader.dataset.rowindex = String(rows.indexOf(row.getData()));
      },
      rangeAdded: range => {
        const rowIndexes = range.getRows().map(row => rows.indexOf(row.getData()));
        setSelection(rowIndexes.filter(index => index >= 0));
      },
      rangeRemoved: () => setSelection([]),
    });
    tableRef.current = table;
    return () => { table.destroy(); tableRef.current = null; };
  }, [cols, error, result, rows]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches('input, textarea')) return;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        tableRef.current?.clearCellSelection();
        setSelection([]);
      } else if ((event.ctrlKey || event.metaKey) && key === 'c' && !event.shiftKey && activeCellRef.current && !window.getSelection()?.toString()) {
        event.preventDefault();
        const active = activeCellRef.current;
        clipboardInsert(rows[active.rowindex]?.[active.colname]);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'c' && selection.length) {
        event.preventDefault();
        clipboardInsert(rowsToCSV(selection.map(index => rows[index]).filter(Boolean), cols));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cols, rows, selection]);

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
