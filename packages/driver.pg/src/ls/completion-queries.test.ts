import queries from './queries';
import { ContextValue } from '@sqltools/types';

describe('PostgreSQL complete completion catalog', () => {
  it('keeps normal limits but removes them only for catalog metadata', () => {
    for (const query of [queries.searchTables, queries.searchSchemas]) {
      expect(String(query({ search: '' }))).toMatch(/LIMIT 100/);
      expect(String(query({ search: '', completionCatalog: true }))).not.toMatch(/\bLIMIT\b/);
    }
  });

  it('loads all columns with exact table and schema scope and escaped identifiers', () => {
    const sql = String(queries.searchColumns({
      search: '', completionCatalog: true, tables: [{
        label: "Mi'xed", database: "db", schema: "App's", type: ContextValue.TABLE, isView: false,
      }],
    }));
    expect(sql).toContain("C.TABLE_NAME = 'mi''xed' AND C.TABLE_SCHEMA = 'app''s'");
    expect(sql).not.toMatch(/\bLIMIT\b/);
    expect(String(queries.searchColumns({ search: '', tables: [{
      label: 't', schema: 'public', database: 'db', type: ContextValue.TABLE, isView: false,
    }] }))).toMatch(/LIMIT 100/);
  });
});
