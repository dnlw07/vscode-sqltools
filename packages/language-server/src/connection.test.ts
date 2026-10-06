import Connection from './connection';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import LSContext from './context';
import { ContextValue } from '@sqltools/types';
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
});