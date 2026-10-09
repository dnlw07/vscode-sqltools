import { ContextValue, NSDatabase } from '@sqltools/types';
import Connection from '@sqltools/language-server/src/connection';
import IntellisensePlugin from './language-server';
import { MAX_OBJECT_COMPLETIONS, COMPLETION_LOOKAHEAD } from './completion-list';
import { TextDocument } from 'vscode-languageserver-textdocument';

jest.mock('@sqltools/language-server/src/connection', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    searchItems: jest.fn(),
    getDriver: jest.fn().mockReturnValue('Db2 Driver for SQLTools'),
    getStaticCompletions: jest.fn().mockResolvedValue({}),
  })),
}));

function setup(query: string, tableCount = 2) {
  const plugin = new IntellisensePlugin();
  const conn = new Connection({
    driver: 'Db2 Driver for SQLTools', name: 'test', username: 'test',
    id: 'test', isConnected: true, isActive: true,
  }, jest.fn());
  const search = jest.spyOn(conn, 'searchItems');
  search.mockImplementation(async type => {
    if (type === ContextValue.SCHEMA || type === ContextValue.DATABASE) {
      return [{ label: 'Z_SCHEMA', type: ContextValue.SCHEMA }];
    }
    return Array.from({ length: tableCount }, (_, index): NSDatabase.ITable => ({
      label: `A_TABLE_${index}`, schema: 'Z_SCHEMA', database: '', type: ContextValue.TABLE, isView: false,
    }));
  });
  const offset = query.indexOf('|');
  const complete = () => plugin['getCompletionsFromHueAst']({
    currentWord: query.slice(0, offset).match(/[\w]*$/)[0].toUpperCase(),
    conn, text: query.replace('|', ''), currentOffset: offset,
  });
  return { plugin, conn, search, complete };
}

describe('schema-first table completion', () => {
  it.each(['SELECT * FROM |', 'SELECT * FROM Z|', 'SELECT * FROM s.t JOIN |'])(
    'lists schemas before tables with explicit sorting priorities: %s', async query => {
      const { complete, search } = setup(query);
      const result = await complete();
      expect(result.items.slice(0, 3).map(item => item.label)).toEqual([
        'Z_SCHEMA.', 'A_TABLE_0', 'A_TABLE_1',
      ]);
      expect(result.items[0].detail).toBe('Schema');
      expect(result.items[0].sortText).toBe('0:Z_SCHEMA');
      expect(result.items[1].sortText).toBe('1:A_TABLE_0');
      expect(result.items[0].sortText < result.items[1].sortText).toBe(true);
      expect(search).toHaveBeenCalledWith(ContextValue.SCHEMA, query.includes('Z|') ? 'Z' : '', {}, COMPLETION_LOOKAHEAD);
    }
  );

  it.each([
    'SELECT * FROM Z_SCHEMA.|',
    'SELECT * FROM Z_SCHEMA.A_|',
    'SELECT * FROM s.t JOIN Z_SCHEMA.|',
  ])('does not query or display schemas after qualification: %s', async query => {
    const { complete, search } = setup(query);
    const result = await complete();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(ContextValue.TABLE, query.includes('A_|') ? 'A_' : '',
      { database: 'Z_SCHEMA' }, COMPLETION_LOOKAHEAD);
    expect(result.items.filter(item => item.detail === 'Schema')).toEqual([]);
    expect(result.items[0].label).toBe('A_TABLE_0');
  });

  describe('driver completion lists', () => {
    it.each([true, false])('preserves driver loading/truncation state: %s', async isIncomplete => {
      const plugin = new IntellisensePlugin();
      const document = TextDocument.create('file:///query.sql', 'sql', 1, 'SELECT * FROM ');
      Object.defineProperty(plugin, 'server', { value: { docManager: { get: () => document } } });
      const conn = new Connection({
        driver: 'BigQuery', name: 'test', username: 'test',
        id: 'test', isConnected: true, isActive: true,
      }, jest.fn());
      conn.getCompletionsForRawQuery = jest.fn().mockResolvedValue({
        items: [{ label: 'dataset.' }], isIncomplete,
      });
      plugin['getQueryData'] = jest.fn().mockResolvedValue({ conn, text: document.getText(), currentOffset: 14, currentWord: '' });
      const result = await plugin['onCompletion']({ textDocument: { uri: document.uri }, position: document.positionAt(14) }, undefined, undefined);
      expect(result).toEqual({ items: [{ label: 'dataset.' }], isIncomplete });
    });

    it.each(['array', 'list'])('still caps oversized %s driver responses', async shape => {
      const plugin = new IntellisensePlugin();
      const document = TextDocument.create('file:///query.sql', 'sql', 1, 'SELECT * FROM ');
      Object.defineProperty(plugin, 'server', { value: { docManager: { get: () => document } } });
      const conn = new Connection({
        driver: 'BigQuery', name: 'test', username: 'test',
        id: 'test', isConnected: true, isActive: true,
      }, jest.fn());
      const items = Array.from({ length: 501 }, (_, index) => ({ label: `table_${index}` }));
      conn.getCompletionsForRawQuery = jest.fn().mockResolvedValue(shape === 'array'
        ? items : { items, isIncomplete: false });
      plugin['getQueryData'] = jest.fn().mockResolvedValue({ conn, text: document.getText(), currentOffset: 14, currentWord: '' });
      const result = await plugin['onCompletion']({ textDocument: { uri: document.uri }, position: document.positionAt(14) }, undefined, undefined);
      expect(result).toEqual({ items: items.slice(0, 500), isIncomplete: true });
    });
  });

  it('retains schemas before applying the object completion limit', async () => {
    const { complete } = setup('SELECT * FROM |', COMPLETION_LOOKAHEAD);
    const result = await complete();
    expect(result.isIncomplete).toBe(true);
    const objects = result.items.filter(item => item.detail === 'Schema' || item.detail === 'Table');
    expect(objects).toHaveLength(MAX_OBJECT_COMPLETIONS);
    expect(objects[0].label).toBe('Z_SCHEMA.');
    expect(objects[objects.length - 1].label).toBe(`A_TABLE_${MAX_OBJECT_COMPLETIONS - 2}`);
  });

  it('suppresses schemas even if the parser suggests them alongside qualified tables', async () => {
    const { plugin, complete } = setup('SELECT * FROM Z_SCHEMA.|');
    plugin['getHueAst'] = jest.fn(() => ({
      suggestTables: { identifierChain: [{ name: 'Z_SCHEMA' }] },
      suggestDatabases: { appendDot: true },
    }));
    const result = await complete();
    expect(result.items.some(item => item.detail === 'Schema')).toBe(false);
  });

  it('preserves database lookups for other drivers', async () => {
    const { conn, search, complete } = setup('SELECT * FROM |');
    jest.spyOn(conn, 'getDriver').mockReturnValue('MySQL');
    await complete();
    expect(search).toHaveBeenCalledWith(ContextValue.DATABASE, '', {}, COMPLETION_LOOKAHEAD);
  });

  it('keeps schema navigation out of column completion', async () => {
    const { conn, search, complete } = setup('SELECT * FROM s.t WHERE |');
    search.mockResolvedValue([]);
    await complete();
    expect(search.mock.calls.every(call => call[0] === ContextValue.COLUMN)).toBe(true);
    expect(conn.getDriver()).toBe('Db2 Driver for SQLTools');
  });
});
