import sqlAutocompleteParser from 'gethue/parsers/genericAutocompleteParser.js';
import { parseSqlForCompletion } from './sql-completion-parser';

function parse(query: string, driver = 'Db2 Driver for SQLTools') {
  const offset = query.indexOf('|');
  return parseSqlForCompletion(query.replace('|', ''), offset, driver);
}

function tableNames(ast) {
  return ast.suggestColumns?.tables.map(table => table.identifierChain.map(id => id.name || id.cte).join('.'));
}

describe('Db2 completion parser compatibility', () => {
  it.each([
    'SELECT x FROM s.t WHERE TABLE = 1 AND |',
    'SELECT x FROM s.t ORDER BY TABLE, |',
    'SELECT x FROM s.t WHERE x NOT IN (SELECT TABLE FROM s.u) AND |',
    'SELECT x FROM s.t WHERE t.TABLE = 1 AND |',
  ])('retains column bindings after a TABLE column: %s', query => {
    expect(tableNames(parse(query))).toEqual(['s.t']);
  });

  describe('common Db2 syntax completion scope', () => {
    it.each([
      ['CTE definition', 'WITH recent AS (SELECT | FROM s.employees) SELECT * FROM recent', 'select'],
      ['FETCH FIRST projection', 'SELECT | FROM s.employees e FETCH FIRST 10 ROWS ONLY', 'select'],
      ['FETCH FIRST predicate', 'SELECT id FROM s.employees WHERE | FETCH FIRST 10 ROWS ONLY', 'where'],
      ['FETCH FIRST ordering', 'SELECT id FROM s.employees ORDER BY | FETCH FIRST 10 ROWS ONLY', 'order by'],
      ['WITH UR projection', 'SELECT | FROM s.employees WITH UR', 'select'],
      ['WITH UR predicate', 'SELECT id FROM s.employees WHERE | WITH UR', 'where'],
      ['FETCH FIRST with WITH UR', 'SELECT id FROM s.employees ORDER BY | FETCH FIRST 10 ROWS ONLY WITH UR', 'order by'],
      ['window partition', 'SELECT ROW_NUMBER() OVER (PARTITION BY | ORDER BY id) FROM s.employees', 'select'],
      ['window ordering', 'SELECT ROW_NUMBER() OVER (ORDER BY |) FROM s.employees', 'select'],
      ['aggregate window ordering', 'SELECT SUM(salary) OVER (PARTITION BY department ORDER BY |) FROM s.employees', 'select'],
    ])('retains base-table column scope for %s', (_label, query, source) => {
      const ast = parse(query);
      expect(tableNames(ast)).toEqual(['s.employees']);
      expect(ast.suggestColumns.source).toBe(source);
      if (query.includes('employees e')) {
        expect(ast.suggestColumns.tables[0].alias).toBe('e');
      } else {
        expect(ast.suggestColumns.tables[0].alias).toBeUndefined();
      }
    });

    it('retains CTE references and projected-column metadata', () => {
      const ast = parse('WITH recent AS (SELECT id, name FROM s.employees) SELECT | FROM recent');
      expect(tableNames(ast)).toEqual(['recent']);
      expect(ast.suggestColumns.tables[0].identifierChain).toEqual([{ cte: 'recent' }]);
      expect(ast.commonTableExpressions).toEqual([{
        alias: 'recent',
        columns: [
          { identifierChain: [{ name: 's' }, { name: 'employees' }, { name: 'id' }], type: 'COLREF' },
          { identifierChain: [{ name: 's' }, { name: 'employees' }, { name: 'name' }], type: 'COLREF' },
        ],
      }]);
    });

    it.each(['UNION', 'UNION ALL'])('retains both SELECT branches of %s', operator => {
      expect(tableNames(parse(`SELECT | FROM s.employees ${operator} SELECT id FROM s.incoming`))).toEqual(['s.employees']);
      expect(tableNames(parse(`SELECT id FROM s.employees ${operator} SELECT | FROM s.incoming`))).toEqual(['s.incoming']);
    });
  });

  // These characterize existing Hue limitations, not successful Db2 syntax support.
  describe('known Db2 completion limitations', () => {
    it('misreads unaliased FETCH FIRST as a table alias in the projection', () => {
      const ast = parse('SELECT | FROM s.employees FETCH FIRST 10 ROWS ONLY');
      expect(tableNames(ast)).toEqual(['s.employees']);
      expect(ast.suggestColumns.tables[0].alias).toBe('FETCH');
    });

    it.each([
      "SELECT | FROM FINAL TABLE (INSERT INTO s.employees (id) VALUES (1))",
      "SELECT | FROM FINAL TABLE (UPDATE s.employees SET name = 'x' WHERE id = 1)",
    ])('does not resolve the target table of a FINAL TABLE expression: %s', query => {
      expect(tableNames(parse(query))).toEqual(['FINAL']);
    });

    it.each([
      'MERGE INTO s.employees t USING s.incoming u ON | WHEN MATCHED THEN UPDATE SET t.name = u.name',
      'MERGE INTO s.employees t USING s.incoming u ON t.id = u.id WHEN MATCHED THEN UPDATE SET |',
    ])('does not provide MERGE column scope: %s', query => {
      expect(parse(query).suggestColumns).toBeUndefined();
    });

    it('does not provide window ordering scope when followed by a ROWS frame', () => {
      const ast = parse('SELECT SUM(salary) OVER (ORDER BY | ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM s.employees');
      expect(ast.suggestColumns).toBeUndefined();
    });

    it.each(['INTERSECT', 'INTERSECT ALL', 'INTERSECT DISTINCT'])(
      'misreads %s as an alias and loses second-branch column scope', operator => {
        const first = parse(`SELECT | FROM s.employees ${operator} SELECT id FROM s.incoming`);
        expect(tableNames(first)).toEqual(['s.employees']);
        expect(first.suggestColumns.tables[0].alias).toBe('INTERSECT');
        expect(parse(`SELECT id FROM s.employees ${operator} SELECT | FROM s.incoming`).suggestColumns).toBeUndefined();
      }
    );
  });

  it.each(['EXCEPT', 'EXCEPT ALL', 'EXCEPT DISTINCT', 'except'])(
    'uses the correct branch for %s', operator => {
      expect(tableNames(parse(`SELECT | FROM s.t ${operator} SELECT x FROM s.u`))).toEqual(['s.t']);
      expect(tableNames(parse(`SELECT x FROM s.t ${operator} SELECT | FROM s.u`))).toEqual(['s.u']);
      expect(tableNames(parse(`SELECT TABLE FROM s.t ${operator} SELECT TABLE FROM s.u WHERE TABLE = 1 AND |`))).toEqual(['s.u']);
    }
  );

  it('supports nested set operations and aliases', () => {
    const ast = parse('SELECT x FROM s.t WHERE x IN (SELECT TABLE FROM s.u EXCEPT SELECT | FROM s.v v)');
    expect(tableNames(ast)).toEqual(['s.v']);
    expect(ast.suggestColumns.tables[0].alias).toBe('v');
  });

  it('restores TABLE relation and alias identifiers without confusing existing names', () => {
    const ast = parse('SELECT TBL00 FROM s.TABLE TABLE WHERE TABLE.x = 1 AND |');
    expect(tableNames(ast)).toEqual(['s.TABLE']);
    expect(ast.suggestColumns.tables[0].alias).toBe('TABLE');
  });

  it('retains original identifier case and does not rewrite a quoted placeholder name', () => {
    const ast = parse('SELECT "TBL00" FROM s.table TaBlE WHERE TaBlE.x = 1 AND |');
    expect(tableNames(ast)).toEqual(['s.table']);
    expect(ast.suggestColumns.tables[0].alias).toBe('TaBlE');
  });

  it.each([
    "SELECT x FROM s.t WHERE x = 'TABLE EXCEPT ''TABLE''' AND |",
    'SELECT "TABLE", "EXCEPT" FROM s.t WHERE |',
    'SELECT x FROM s.t /* TABLE EXCEPT /* nested */ TABLE */ WHERE |',
    'SELECT x FROM s.t -- TABLE EXCEPT\nWHERE |',
    'CREATE TABLE s.t (|)',
    'CREATE GLOBAL TEMPORARY TABLE s.t (|)',
    'DECLARE GLOBAL TEMPORARY TABLE s.t (|)',
    'ALTER TABLE s.t |',
    'DROP TABLE |',
    'SELECT * FROM TABLE(s.fn()) f WHERE |',
    'SELECT x FROM s.t WHERE x = \'TABLE EXCEPT',
    'SELECT x FROM s.t /* TABLE EXCEPT',
  ])('preserves quoted text, comments and structural TABLE tokens: %s', query => {
    const offset = query.indexOf('|');
    const text = query.replace('|', '');
    expect(parse(query)).toEqual(sqlAutocompleteParser.parseSql(text.slice(0, offset), text.slice(offset)));
  });

  it.each(['PostgreSQL', 'MySQL', 'MSSQL', ''])('does not change %s parsing', driver => {
    const query = 'SELECT x FROM s.t EXCEPT SELECT | FROM s.u';
    const offset = query.indexOf('|');
    const text = query.replace('|', '');
    expect(parse(query, driver)).toEqual(sqlAutocompleteParser.parseSql(text.slice(0, offset), text.slice(offset)));
  });

  it('preserves wildcard offsets on multiline input', () => {
    const ast = parse('SELECT TABLE FROM s.t EXCEPT\nSELECT *| FROM s.u');
    const wildcard = ast.locations.find(location => location.type === 'asterisk' && location.location.first_line === 2);
    expect(wildcard.location.first_column).toBe(8);
    expect(wildcard.tables[0].identifierChain.map(id => id.name)).toEqual(['s', 'u']);
  });

  it('does not add empty-WHERE recovery', () => {
    const query = 'SELECT * FROM s.t WHERE ORDER BY |';
    const offset = query.indexOf('|');
    expect(parse(query)).toEqual(sqlAutocompleteParser.parseSql(query.slice(0, offset), ''));
  });
});
