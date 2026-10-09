import Connection from './connection';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import LSContext from './context';
import { ContextValue, NSDatabase } from '@sqltools/types';
import fs from 'fs';

jest.mock('./context', () => ({ __esModule: true, default: { drivers: new Map() } }));
jest.mock('@sqltools/log/src', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@sqltools/util/config-manager', () => ({ __esModule: true, default: {} }));
jest.mock('@sqltools/util/path', () => ({
  getDataPath: () => require('path').join(require('os').tmpdir(), `sqltools-autosuggestions-test-${process.pid}.json`),
}));

const cachePath = require('path').join(require('os').tmpdir(), `sqltools-autosuggestions-test-${process.pid}.json`);

describe('connection completion cache', () => {
  let connection: Connection;
  let driver: any;
  let connectionId = 0;

  beforeEach(async () => {
    await (Connection as any).persistenceQueue;
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    (Connection as any).completionSnapshots.clear();
    (Connection as any).completionSnapshotsLoaded = false;
    driver = {
      credentials: {},
      searchItems: jest.fn(async () => [{ label: 'TABLES' }]),
      getStaticCompletions: jest.fn(async () => ({ COUNT: { label: 'COUNT' } })),
      testConnection: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    };
    LSContext.drivers.set('cache-test', class {
      constructor() { return driver; }
    } as any);
    connection = new Connection({ id: `cache-test-${++connectionId}`, driver: 'cache-test' } as any, jest.fn());
  });

  afterAll(() => {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
  });

  describe('table DDL driver delegation', () => {
    const table: NSDatabase.ITable = {
      label: 'MixedCase', schema: 'App', database: 'DB', type: ContextValue.TABLE, isView: false,
    };

    it('rejects disconnected connections before calling the driver', async () => {
      driver.generateTableDDL = jest.fn(async () => 'CREATE TABLE "App"."MixedCase" ("ID" INTEGER);');
      await expect(connection.generateTableDDL(table)).rejects.toThrow('Connect to the database');
      expect(driver.generateTableDDL).not.toHaveBeenCalled();
    });

    it('keeps old drivers compatible and explicitly reports missing DDL support', async () => {
      await connection.connect();
      await expect(connection.generateTableDDL(table)).rejects.toThrow('not supported by');
    });

    it('passes exact catalog identifiers to the optional hook', async () => {
      const ddl = 'CREATE TABLE "App"."MixedCase" ("ID" INTEGER);';
      driver.generateTableDDL = jest.fn(async () => ddl);
      await connection.connect();
      await expect(connection.generateTableDDL(table)).resolves.toBe(ddl);
      expect(driver.generateTableDDL).toHaveBeenCalledWith(table);
    });

    it('rejects views even when the driver implements the hook', async () => {
      driver.generateTableDDL = jest.fn(async () => 'CREATE VIEW v AS SELECT 1;');
      await connection.connect();
      const view = { ...table };
      Object.defineProperty(view, 'type', { value: ContextValue.VIEW });
      await expect(connection.generateTableDDL(view)).rejects.toThrow('requires a table');
      expect(driver.generateTableDDL).not.toHaveBeenCalled();
    });

    it('rejects empty DDL returned by the driver', async () => {
      driver.generateTableDDL = jest.fn(async () => ' \n ');
      await connection.connect();
      await expect(connection.generateTableDDL(table)).rejects.toThrow('No table DDL');
    });

    it('propagates actual driver failures', async () => {
      driver.generateTableDDL = jest.fn(async () => { throw new Error('Catalog permission denied'); });
      await connection.connect();
      await expect(connection.generateTableDDL(table)).rejects.toThrow('Catalog permission denied');
    });
  });

  it('deduplicates concurrent and repeated searches with equivalent contexts', async () => {
    await Promise.all([
      connection.searchItems(ContextValue.TABLE, '', { database: 'SYSCAT', limit: 200 }),
      connection.searchItems(ContextValue.TABLE, '', { limit: 200, database: 'SYSCAT' }),
    ]);
    await connection.searchItems(ContextValue.TABLE, '', { database: 'SYSCAT', limit: 200 });
    expect(driver.searchItems).toHaveBeenCalledTimes(1);
  });

  it('keeps prefixes, object types, and schema contexts separate', async () => {
    await connection.searchItems(ContextValue.TABLE, '', { database: 'SYSCAT' });
    await connection.searchItems(ContextValue.TABLE, 'PROC', { database: 'SYSCAT' });
    await connection.searchItems(ContextValue.TABLE, '', { database: 'APP' });
    await connection.searchItems(ContextValue.SCHEMA, '', { database: 'SYSCAT' });
    expect(driver.searchItems).toHaveBeenCalledTimes(4);
  });

  it('returns independent item copies', async () => {
    const first = await connection.searchItems(ContextValue.TABLE);
    first[0].label = 'changed';
    const second = await connection.searchItems(ContextValue.TABLE);
    expect(second[0].label).toBe('TABLES');
  });

  it('limits returned copies without truncating the cached catalog', async () => {
    const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
    const key = JSON.stringify([ContextValue.TABLE, '', {}]);
    (connection as any).fallbackCompletionCache = new Map([[key, Promise.resolve(catalog)]]);
    const limited = await connection.searchItems(ContextValue.TABLE, '', {}, 501);
    const cachedCatalog = await (connection as any).fallbackCompletionCache.get(key);

    expect(limited).toHaveLength(501);
    expect(cachedCatalog).toHaveLength(72000);
    expect(driver.searchItems).not.toHaveBeenCalled();
  });

  it('stores only bounded typed-search results in the request cache', async () => {
    const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
    driver.searchItems = jest.fn(async () => catalog);

    const limited = await connection.searchItems(ContextValue.TABLE, 'TABLE_', {}, 501);
    const cached = await (connection as any).completionCache.get(
      JSON.stringify([ContextValue.TABLE, 'TABLE_', {}])
    );

    expect(limited).toHaveLength(501);
    expect(cached).toHaveLength(501);
    expect(driver.searchItems).toHaveBeenCalledTimes(1);
  });

  it('stops scanning cached catalog after enough matching suggestions', async () => {
    const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
    const key = JSON.stringify([ContextValue.TABLE, '', {}]);
    (connection as any).fallbackCompletionCache = new Map([[key, Promise.resolve(catalog)]]);

    const matches = await connection.searchItems(ContextValue.TABLE, 'TABLE_', {}, 501);

    expect(matches).toHaveLength(501);
    expect(matches[500].label).toBe('TABLE_500');
    expect(driver.searchItems).not.toHaveBeenCalled();
  });

  it('retries failures rather than caching them', async () => {
    driver.searchItems.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(connection.searchItems(ContextValue.TABLE)).rejects.toThrow('temporary failure');
    await expect(connection.searchItems(ContextValue.TABLE)).resolves.toEqual([{ label: 'TABLES' }]);
    expect(driver.searchItems).toHaveBeenCalledTimes(2);
  });

  it('clears searches and static completions on close', async () => {
    await connection.searchItems(ContextValue.TABLE);
    await connection.getStaticCompletions();
    await connection.getStaticCompletions();
    await connection.close();
    await connection.searchItems(ContextValue.TABLE);
    await connection.getStaticCompletions();
    expect(driver.searchItems).toHaveBeenCalledTimes(2);
    expect(driver.getStaticCompletions).toHaveBeenCalledTimes(2);
  });

  it('serves the previous search cache until schema and table warm-up succeeds', async () => {
    await connection.searchItems(ContextValue.TABLE, 'CACHED');
    await connection.connect();
    await connection.close();

    let resolveSchemas!: (items: any[]) => void;
    let resolveTables!: (items: any[]) => void;
    driver.searchItems = jest.fn((itemType: ContextValue, search: string) => {
      if (itemType === ContextValue.SCHEMA) return new Promise(resolve => { resolveSchemas = resolve; });
      if (itemType === ContextValue.TABLE && search === '') return new Promise(resolve => { resolveTables = resolve; });
      return Promise.resolve([{ label: 'FRESH' }]);
    });
    connection = new Connection({ id: `cache-test-${connectionId}`, driver: 'cache-test' } as any, jest.fn());

    await connection.connect();
    await expect(connection.searchItems(ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'TABLES' }]);
    expect(driver.searchItems).not.toHaveBeenCalledWith(ContextValue.TABLE, 'CACHED', expect.anything());

    resolveSchemas([{ label: 'PUBLIC' }]);
    resolveTables([{ label: 'FRESH_TABLE' }]);
    await new Promise(resolve => setTimeout(resolve, 0));

    await expect(connection.searchItems(ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'FRESH' }]);
    expect(driver.searchItems).toHaveBeenCalledWith(ContextValue.TABLE, 'CACHED', {});
  });

  it('retains the previous cache when schema and table warm-up fails', async () => {
    await connection.searchItems(ContextValue.TABLE, 'CACHED');
    await connection.connect();
    await connection.close();

    driver.searchItems = jest.fn((itemType: ContextValue) => {
      if (itemType === ContextValue.SCHEMA) return Promise.reject(new Error('warm-up failed'));
      return Promise.resolve([{ label: 'FRESH_TABLE' }]);
    });
    connection = new Connection({ id: `cache-test-${connectionId}`, driver: 'cache-test' } as any, jest.fn());

    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(connection.searchItems(ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'TABLES' }]);
    expect(driver.searchItems).not.toHaveBeenCalledWith(ContextValue.TABLE, 'CACHED', expect.anything());
  });

  it('restores warmed schema and table suggestions from disk after a server restart', async () => {
    driver.searchItems = jest.fn(async (itemType: ContextValue) => [
      { label: itemType === ContextValue.SCHEMA ? 'PUBLIC' : 'TABLES' },
    ]);
    await connection.connect();
    await new Promise(resolve => setTimeout(resolve, 0));
    await (Connection as any).persistenceQueue;

    (Connection as any).completionSnapshots.clear();
    (Connection as any).completionSnapshotsLoaded = false;
    driver.searchItems = jest.fn(async () => [{ label: 'NETWORK_RESULT' }]);
    connection = new Connection({ id: `cache-test-${connectionId}`, driver: 'cache-test' } as any, jest.fn());

    await expect(connection.searchItems(ContextValue.TABLE, 'TAB')).resolves.toEqual([{ label: 'TABLES' }]);
    expect(driver.searchItems).not.toHaveBeenCalled();
  });

  it('keeps the previous cache file when a snapshot exceeds the persistence limit', async () => {
    const previousCache = '{"version":1,"snapshots":[{"id":"previous"}]}';
    fs.writeFileSync(cachePath, previousCache, 'utf8');
    (Connection as any).completionSnapshots.set('oversized-cache-test', new Map([
      [JSON.stringify([ContextValue.TABLE, '']), Promise.resolve([{ label: 'A'.repeat(100) }])],
    ]));
    const maxBytes = (Connection as any).maxPersistedCompletionCacheBytes;
    (Connection as any).maxPersistedCompletionCacheBytes = 1;

    try {
      await (connection as any).persistCompletionSnapshot();
      expect(fs.readFileSync(cachePath, 'utf8')).toBe(previousCache);
    } finally {
      (Connection as any).maxPersistedCompletionCacheBytes = maxBytes;
    }
  });

  it('does not let a pre-reset failure evict a newer request', async () => {
    let rejectPending!: (error: Error) => void;
    driver.searchItems.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectPending = reject;
    }));
    const oldRequest = connection.searchItems(ContextValue.TABLE);
    const oldFailure = expect(oldRequest).rejects.toThrow('old request');
    await connection.close();
    await connection.searchItems(ContextValue.TABLE);
    rejectPending(new Error('old request'));
    await oldFailure;
    await connection.searchItems(ContextValue.TABLE);
    expect(driver.searchItems).toHaveBeenCalledTimes(2);
  });

  it('rejects a driver that is not registered', () => {
    expect(() => new Connection({ driver: 'missing-driver' } as any, jest.fn())).toThrow();
  });

  it('clears prompted passwords when closing', async () => {
    driver.credentials = { askForPassword: true, password: 'temporary' };
    await connection.close();
    expect(driver.credentials.password).toBeUndefined();
  });

  it('preserves a saved password when closing', async () => {
    driver.credentials = { password: 'saved' };
    await connection.close();
    expect(driver.credentials.password).toBe('saved');
  });

  it('returns an empty tree if the driver has no tree provider', async () => {
    await expect(connection.getChildrenForItem({ item: {} as any })).resolves.toEqual([]);
  });

  it('delegates tree lookups to supported drivers', async () => {
    const params = { item: { label: 'Schemas' } as any };
    driver.getChildrenForItem = jest.fn(async () => [{ label: 'PUBLIC' }]);
    await expect(connection.getChildrenForItem(params)).resolves.toEqual([{ label: 'PUBLIC' }]);
    expect(driver.getChildrenForItem).toHaveBeenCalledWith(params);
  });

  it('serializes the connection ID without an undefined credential overriding it', () => {
    driver.credentials = { id: undefined, name: 'Test', driver: 'cache-test', server: 'localhost', database: 'test' };
    expect(connection.serialize().id).toBe(connection.getId());
    expect(typeof connection.serialize().id).toBe('string');
  });

  it('supplies required IDs on error results without a request ID', async () => {
    driver.credentials = { id: 'test-connection', driver: 'cache-test' };
    driver.query = jest.fn(async () => { throw new Error('Query failed'); });
    const [result] = await connection.query('SELECT broken');
    expect(result.error).toBe(true);
    expect(result.requestId).toEqual(expect.any(String));
    expect(result.connId).toBe('test-connection');
  });

  describe('complete driver catalogs', () => {
    beforeEach(() => {
      driver.supportsCompletionCatalog = true;
      driver.searchItems = jest.fn(async (type: ContextValue, _search: string, context: any) => {
        if (type === ContextValue.SCHEMA) return Array.from({ length: 500 }, (_, index) => ({
          label: index === 499 ? 'customer_order_history' : `SCHEMA_${index}`, type,
        }));
        if (type === ContextValue.COLUMN) return [
          { label: 'customer_order_history', schema: context.tables[0].database, table: context.tables[0].label, type },
        ];
        return Array.from({ length: 23000 }, (_, index) => ({
          label: index === 22999 ? 'customer_order_history' : `TABLE_${index}`,
          schema: index % 2 ? 'OTHER' : 'PUBLIC', type: ContextValue.TABLE,
        }));
      });
    });

    it('loads once and filters before limiting, including abbreviated matches near the end', async () => {
      const all = await connection.searchItems(ContextValue.TABLE, '', {}, 501);
      expect(all).toHaveLength(501);
      expect(await connection.searchItems(ContextValue.TABLE, 'custhist')).toEqual([
        expect.objectContaining({ label: 'customer_order_history' }),
      ]);
      expect(driver.searchItems).toHaveBeenCalledTimes(1);
      expect(driver.searchItems).toHaveBeenCalledWith(ContextValue.TABLE, '', { completionCatalog: true });
    });

    it('uses the global table catalog for selected schemas without network fan-out', async () => {
      await connection.searchItems(ContextValue.TABLE, '', { database: 'PUBLIC' }, 501);
      const other = await connection.searchItems(ContextValue.TABLE, 'custhist', { database: 'OTHER' });
      expect(other).toHaveLength(1);
      expect(await connection.searchItems(ContextValue.TABLE, 'custhist', { database: 'PUBLIC' })).toEqual([]);
      expect(driver.searchItems).toHaveBeenCalledTimes(1);
    });

    it('caches complete columns per table and preserves schema scope', async () => {
      const tables = [{ label: 'EMPLOYEE', database: 'PUBLIC' }];
      await connection.searchItems(ContextValue.COLUMN, '', { tables });
      const found = await connection.searchItems(ContextValue.COLUMN, 'custhist', { tables });
      expect(found[0].label).toBe('customer_order_history');
      await connection.searchItems(ContextValue.COLUMN, '', { tables: [{ label: 'EMPLOYEE', database: 'OTHER' }] });
      expect(driver.searchItems).toHaveBeenCalledTimes(3);
    });

    it('limits concurrent on-demand column requests to four', async () => {
      let active = 0;
      let peak = 0;
      driver.searchItems = jest.fn(async (type: ContextValue) => {
        if (type === ContextValue.TABLE) return [];
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 0));
        active--;
        return [];
      });
      await connection.searchItems(ContextValue.COLUMN, '', {
        tables: Array.from({ length: 20 }, (_, index) => ({ label: `T${index}`, database: 'PUBLIC' })),
      });
      expect(peak).toBeLessThanOrEqual(4);
      expect(driver.searchItems).toHaveBeenCalledTimes(21);
    });

    it('refresh replaces catalog and invalidates cached column lists', async () => {
      await connection.connect();
      await new Promise(resolve => setTimeout(resolve, 0));
      await (connection as any).catalogRefresh;
      await connection.searchItems(ContextValue.COLUMN, '', { tables: [{ label: 'EMPLOYEE', database: 'PUBLIC' }] });
      driver.searchItems = jest.fn(async () => [{ label: 'NEW_OBJECT' }]);
      await connection.refreshCompletionCatalog();
      expect((await connection.searchItems(ContextValue.TABLE))[0].label).toBe('NEW_OBJECT');
      expect((await connection.searchItems(ContextValue.COLUMN, '', {
        tables: [{ label: 'EMPLOYEE', database: 'PUBLIC' }],
      }))[0].label).toBe('NEW_OBJECT');
    });

    it('restores complete catalog snapshots without an API call', async () => {
      await connection.connect();
      await (connection as any).catalogRefresh;
      await (Connection as any).persistenceQueue;
      (Connection as any).completionSnapshots.clear();
      (Connection as any).completionSnapshotsLoaded = false;
      driver.searchItems.mockClear();
      const restored = new Connection({ id: `cache-test-${connectionId}`, driver: 'cache-test' } as any, jest.fn());
      expect((await restored.searchItems(ContextValue.TABLE, 'custhist'))[0].label).toBe('customer_order_history');
      expect(driver.searchItems).not.toHaveBeenCalled();
    });

    it('uses the same complete schema catalog for database and schema requests', async () => {
      expect(await connection.searchItems(ContextValue.DATABASE, '', {}, 50)).toHaveLength(50);
      const matches = await connection.searchItems(ContextValue.SCHEMA, 'custhist');
      expect(matches).toHaveLength(1);
      expect(matches[0].label).toBe('customer_order_history');
      expect(driver.searchItems).toHaveBeenCalledTimes(1);
    });

    it('searches 23,000 tables locally without additional queries', async () => {
      await connection.searchItems(ContextValue.TABLE, '', {}, 501);
      const start = Date.now();
      for (let index = 0; index < 20; index++) {
        expect(await connection.searchItems(ContextValue.TABLE, 'custhist', {}, 501)).toHaveLength(1);
      }
      expect(Date.now() - start).toBeLessThan(5000);
      expect(driver.searchItems).toHaveBeenCalledTimes(1);
    });

    it('protects schema/table catalogs from request-cache churn and keeps them on disconnect', async () => {
      await connection.connect();
      await (connection as any).catalogRefresh;
      for (let index = 0; index < 260; index++) {
        await connection.searchItems(ContextValue.COLUMN, '', {
          tables: [{ label: `UNKNOWN_${index}`, database: 'PUBLIC' }],
        });
      }
      driver.searchItems.mockClear();
      expect(await connection.searchItems(ContextValue.TABLE, 'custhist')).toHaveLength(1);
      expect(await connection.searchItems(ContextValue.SCHEMA, 'custhist')).toHaveLength(1);
      await connection.close();
      const restored = new Connection({ id: `cache-test-${connectionId}`, driver: 'cache-test' } as any, jest.fn());
      expect(await restored.searchItems(ContextValue.TABLE, 'custhist')).toHaveLength(1);
      expect(driver.searchItems).not.toHaveBeenCalled();
    });

    it('preserves exact catalog identifiers for columns and isolates same-name tables by schema', async () => {
      driver.searchItems = jest.fn(async (type: ContextValue, _search: string, context: any) =>
        type === ContextValue.TABLE ? [
          { label: 'mixed', catalogLabel: 'MiXed', schema: 'App', type: ContextValue.TABLE },
          { label: 'mixed', catalogLabel: 'MiXed', schema: 'Other', type: ContextValue.TABLE },
        ] : [{ label: 'id', schema: context.tables[0].schema }]);
      expect(await connection.searchItems(ContextValue.COLUMN, '', {
        tables: [{ label: 'mixed', database: 'app' }],
      })).toEqual([{ label: 'id', schema: 'App' }]);
      expect(driver.searchItems).toHaveBeenLastCalledWith(ContextValue.COLUMN, '', {
        completionCatalog: true,
        tables: [{ label: 'MiXed', schema: 'App', database: 'App', catalogResolved: true }],
      });
    });

    it('prevents a disconnected background refresh from replacing the next connection catalog', async () => {
      await connection.connect();
      await (connection as any).catalogRefresh;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      driver.searchItems = jest.fn(async () => { await pending; return [{ label: 'OLD_OBJECT' }]; });
      const refresh = connection.refreshCompletionCatalog();
      await connection.close();
      driver.searchItems = jest.fn(async () => [{ label: 'NEW_OBJECT' }]);
      await connection.connect();
      await (connection as any).catalogRefresh;
      release();
      await refresh;
      expect((await connection.searchItems(ContextValue.TABLE))[0].label).toBe('NEW_OBJECT');
    });

    it('keeps stale data usable during background refresh and reports explicit refresh failures', async () => {
      await connection.connect();
      await (connection as any).catalogRefresh;
      (connection as any).catalogRefreshedAt = 0;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      driver.searchItems = jest.fn(async () => { await pending; throw new Error('permission denied'); });
      const result = await connection.searchItems(ContextValue.TABLE, 'custhist');
      expect(result[0].label).toBe('customer_order_history');
      release();
      await expect((connection as any).catalogRefresh).rejects.toThrow('permission denied');
      await expect(connection.refreshCompletionCatalog()).rejects.toThrow('permission denied');
      expect((await connection.searchItems(ContextValue.TABLE, 'custhist'))[0].label).toBe('customer_order_history');
    });
  });
});