import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContextValue, MConnectionExplorer } from '@sqltools/types';
import { getWildcardCompletion } from './wildcard-completion';

const table: MConnectionExplorer.IChildItem = {
  label: 'EMPLOYEES', schema: 'QDR00687', database: '', type: ContextValue.TABLE,
};
const group: MConnectionExplorer.IChildItem = {
  label: 'Column', schema: '', database: '', type: ContextValue.RESOURCE_GROUP, childType: ContextValue.COLUMN,
};
const column = (label: string): MConnectionExplorer.IChildItem => ({
  label, schema: 'QDR00687', database: '', type: ContextValue.COLUMN,
});

function setup(query: string, labels = ['EMPLOYEE_ID', 'FIRST_NAME']) {
  const offset = query.indexOf('|');
  const document = TextDocument.create('file:///query.sql', 'sql', 1, query.replace('|', ''));
  const conn = {
    searchItems: jest.fn().mockResolvedValue([table]),
    getChildrenForItem: jest.fn()
      .mockResolvedValueOnce([group])
      .mockResolvedValueOnce(labels.map(column)),
  };
  return { document, offset, conn };
}

describe('wildcard column expansion', () => {
  it.each(['SELECT *| FROM qdr00687.employees;', 'SELECT |* FROM qdr00687.employees;'])(
    'replaces the wildcard for either selection direction: %s', async query => {
      const { document, offset, conn } = setup(query);
      const item = await getWildcardCompletion(document, offset, conn);
      expect(item.label).toBe('Expand * to all columns');
      expect(item.textEdit).toEqual({
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
        newText: 'EMPLOYEE_ID, FIRST_NAME',
      });
      expect(conn.getChildrenForItem).toHaveBeenLastCalledWith({ item: group, parent: table });
    }
  );

  it('expands more than the regular 500-column completion limit', async () => {
    const labels = Array.from({ length: 650 }, (_, index) => `COL_${index}`);
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;', labels);
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe(labels.join(', '));
    expect(item.detail).toContain('650 columns');
  });

  it.each([
    'SELECT *| FROM qdr00687.employees WHERE TABLE = 1;',
    'SELECT *| FROM qdr00687.employees EXCEPT SELECT TABLE FROM other.employees;',
    'SELECT TABLE FROM other.employees EXCEPT SELECT *| FROM qdr00687.employees;',
    'SELECT TABLE FROM other.employees EXCEPT ALL\nSELECT e.*| FROM qdr00687.employees e;',
  ])('expands a Db2 wildcard with TABLE and EXCEPT: %s', async query => {
    const { document, offset, conn } = setup(query);
    const item = await getWildcardCompletion(document, offset, {
      ...conn, getDriver: () => 'Db2 Driver for SQLTools',
    });
    const qualifier = query.includes('e.*') ? 'e.' : '';
    expect(item.textEdit.newText).toBe(`${qualifier}EMPLOYEE_ID, ${qualifier}FIRST_NAME`);
    expect(conn.searchItems).toHaveBeenCalledWith(ContextValue.TABLE, 'employees', {
      database: 'qdr00687', limit: 2147483647,
    });
    const star = query.indexOf('*');
    expect(item.textEdit.range).toEqual({
      start: document.positionAt(star - qualifier.length),
      end: document.positionAt(star + 1),
    });
  });

  it('preserves column metadata order and removes duplicate metadata rows', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;', ['Z', 'A', 'Z']);
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe('Z, A');
  });

  it.each(['\n', '\r\n'])('only replaces the selected statement wildcard with %j line endings', async newline => {
    const { document, offset, conn } = setup(`SELECT * FROM unrelated;${newline}SELECT *| FROM qdr00687.employees;`);
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.range).toEqual({
      start: { line: 1, character: 7 }, end: { line: 1, character: 8 },
    });
  });

  it.each(['SELECT e.*| FROM qdr00687.employees e;', 'SELECT e.|* FROM qdr00687.employees e;'])(
    'qualifies every column for %s', async query => {
      const { document, offset, conn } = setup(query);
      const item = await getWildcardCompletion(document, offset, conn);
      expect(item.textEdit.newText).toBe('e.EMPLOYEE_ID, e.FIRST_NAME');
      expect(item.textEdit.range.start.character).toBe(7);
      expect(item.textEdit.range.end.character).toBe(10);
    }
  );

  it('retains a qualified wildcard scope in a join', async () => {
    const { document, offset, conn } = setup(
      'SELECT e.*| FROM qdr00687.employees e JOIN qdr00687.departments d ON e.department = d.id;'
    );
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe('e.EMPLOYEE_ID, e.FIRST_NAME');
    expect(conn.searchItems).toHaveBeenCalledWith(ContextValue.TABLE, 'employees', {
      database: 'qdr00687', limit: 2147483647,
    });
  });

  it('retains a quoted qualifier on every column', async () => {
    const { document, offset, conn } = setup('SELECT `e`.*| FROM qdr00687.employees `e`;');
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe('`e`.EMPLOYEE_ID, `e`.FIRST_NAME');
    expect(item.textEdit.range.start.character).toBe(7);
  });

  it.each([
    'SELECT COUNT(*|) FROM qdr00687.employees;',
    'SELECT salary *| 2 FROM qdr00687.employees;',
    "SELECT '*|' FROM qdr00687.employees;",
    'SELECT 1 /*| comment */ FROM qdr00687.employees;',
    'SELECT *| FROM employees JOIN departments ON employees.id = departments.id;',
    'SELECT *| FROM (SELECT * FROM qdr00687.employees) e;',
    'SELECT | FROM qdr00687.employees;',
  ])('does not expand a non-catalog or non-projection star: %s', async query => {
    const { document, offset, conn } = setup(query);
    expect(await getWildcardCompletion(document, offset, conn)).toBeUndefined();
    expect(conn.searchItems).not.toHaveBeenCalled();
  });

  it('uses a unique schema match rather than a similarly named table', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;');
    conn.searchItems.mockResolvedValue([{ ...table, schema: 'OTHER' }, table, { ...table, label: 'EMPLOYEES_OLD' }]);
    await getWildcardCompletion(document, offset, conn);
    expect(conn.getChildrenForItem).toHaveBeenNthCalledWith(1, { item: table });
  });

  it('rejects ambiguous unqualified table names', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM employees;');
    conn.searchItems.mockResolvedValue([table, { ...table, schema: 'OTHER' }]);
    await expect(getWildcardCompletion(document, offset, conn)).rejects.toThrow('expected one table');
  });

  it('reports missing metadata instead of inserting an empty list', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;', []);
    await expect(getWildcardCompletion(document, offset, conn)).rejects.toThrow('no column metadata');
  });

  it('supports legacy drivers returning columns directly', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;');
    conn.getChildrenForItem.mockReset();
    conn.getChildrenForItem.mockResolvedValue([column('ID')]);
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe('ID');
  });

  it.each(['EMPLOYEE_ID', 'first_name', 'select'])('inserts column name %s without quotes', async label => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;', [label]);
    const item = await getWildcardCompletion(document, offset, conn);
    expect(item.textEdit.newText).toBe(label);
  });

  it('propagates metadata failures to the completion handler for logging', async () => {
    const { document, offset, conn } = setup('SELECT *| FROM qdr00687.employees;');
    conn.searchItems.mockRejectedValue(new Error('Metadata query failed'));
    await expect(getWildcardCompletion(document, offset, conn)).rejects.toThrow('Metadata query failed');
  });
});
