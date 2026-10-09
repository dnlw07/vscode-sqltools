"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const connection_1 = __importDefault(require("./connection"));
const globals_1 = require("@jest/globals");
const context_1 = __importDefault(require("./context"));
const types_1 = require("@sqltools/types");
const fs_1 = __importDefault(require("fs"));
globals_1.jest.mock('./context', () => ({ __esModule: true, default: { drivers: new Map() } }));
globals_1.jest.mock('@sqltools/log/src', () => ({ createLogger: () => ({ error: globals_1.jest.fn() }) }));
globals_1.jest.mock('@sqltools/util/config-manager', () => ({ __esModule: true, default: {} }));
globals_1.jest.mock('@sqltools/util/path', () => ({
    getDataPath: () => require('path').join(require('os').tmpdir(), `sqltools-autosuggestions-test-${process.pid}.json`),
}));
const cachePath = require('path').join(require('os').tmpdir(), `sqltools-autosuggestions-test-${process.pid}.json`);
(0, globals_1.describe)('connection completion cache', () => {
    let connection;
    let driver;
    let connectionId = 0;
    (0, globals_1.beforeEach)(async () => {
        await connection_1.default.persistenceQueue;
        if (fs_1.default.existsSync(cachePath))
            fs_1.default.unlinkSync(cachePath);
        connection_1.default.completionSnapshots.clear();
        connection_1.default.completionSnapshotsLoaded = false;
        driver = {
            credentials: {},
            searchItems: globals_1.jest.fn(async () => [{ label: 'TABLES' }]),
            getStaticCompletions: globals_1.jest.fn(async () => ({ COUNT: { label: 'COUNT' } })),
            testConnection: globals_1.jest.fn(async () => undefined),
            close: globals_1.jest.fn(async () => undefined),
        };
        context_1.default.drivers.set('cache-test', class {
            constructor() { return driver; }
        });
        connection = new connection_1.default({ id: `cache-test-${++connectionId}`, driver: 'cache-test' }, globals_1.jest.fn());
    });
    (0, globals_1.afterAll)(() => {
        if (fs_1.default.existsSync(cachePath))
            fs_1.default.unlinkSync(cachePath);
    });
    (0, globals_1.describe)('table DDL driver delegation', () => {
        const table = {
            label: 'MixedCase', schema: 'App', database: 'DB', type: types_1.ContextValue.TABLE, isView: false,
        };
        (0, globals_1.it)('rejects disconnected connections before calling the driver', async () => {
            driver.generateTableDDL = globals_1.jest.fn(async () => 'CREATE TABLE "App"."MixedCase" ("ID" INTEGER);');
            await (0, globals_1.expect)(connection.generateTableDDL(table)).rejects.toThrow('Connect to the database');
            (0, globals_1.expect)(driver.generateTableDDL).not.toHaveBeenCalled();
        });
        (0, globals_1.it)('keeps old drivers compatible and explicitly reports missing DDL support', async () => {
            await connection.connect();
            await (0, globals_1.expect)(connection.generateTableDDL(table)).rejects.toThrow('not supported by');
        });
        (0, globals_1.it)('passes exact catalog identifiers to the optional hook', async () => {
            const ddl = 'CREATE TABLE "App"."MixedCase" ("ID" INTEGER);';
            driver.generateTableDDL = globals_1.jest.fn(async () => ddl);
            await connection.connect();
            await (0, globals_1.expect)(connection.generateTableDDL(table)).resolves.toBe(ddl);
            (0, globals_1.expect)(driver.generateTableDDL).toHaveBeenCalledWith(table);
        });
        (0, globals_1.it)('rejects views even when the driver implements the hook', async () => {
            driver.generateTableDDL = globals_1.jest.fn(async () => 'CREATE VIEW v AS SELECT 1;');
            await connection.connect();
            const view = { ...table };
            Object.defineProperty(view, 'type', { value: types_1.ContextValue.VIEW });
            await (0, globals_1.expect)(connection.generateTableDDL(view)).rejects.toThrow('requires a table');
            (0, globals_1.expect)(driver.generateTableDDL).not.toHaveBeenCalled();
        });
        (0, globals_1.it)('rejects empty DDL returned by the driver', async () => {
            driver.generateTableDDL = globals_1.jest.fn(async () => ' \n ');
            await connection.connect();
            await (0, globals_1.expect)(connection.generateTableDDL(table)).rejects.toThrow('No table DDL');
        });
        (0, globals_1.it)('propagates actual driver failures', async () => {
            driver.generateTableDDL = globals_1.jest.fn(async () => { throw new Error('Catalog permission denied'); });
            await connection.connect();
            await (0, globals_1.expect)(connection.generateTableDDL(table)).rejects.toThrow('Catalog permission denied');
        });
    });
    (0, globals_1.it)('deduplicates concurrent and repeated searches with equivalent contexts', async () => {
        await Promise.all([
            connection.searchItems(types_1.ContextValue.TABLE, '', { database: 'SYSCAT', limit: 200 }),
            connection.searchItems(types_1.ContextValue.TABLE, '', { limit: 200, database: 'SYSCAT' }),
        ]);
        await connection.searchItems(types_1.ContextValue.TABLE, '', { database: 'SYSCAT', limit: 200 });
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(1);
    });
    (0, globals_1.it)('keeps prefixes, object types, and schema contexts separate', async () => {
        await connection.searchItems(types_1.ContextValue.TABLE, '', { database: 'SYSCAT' });
        await connection.searchItems(types_1.ContextValue.TABLE, 'PROC', { database: 'SYSCAT' });
        await connection.searchItems(types_1.ContextValue.TABLE, '', { database: 'APP' });
        await connection.searchItems(types_1.ContextValue.SCHEMA, '', { database: 'SYSCAT' });
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(4);
    });
    (0, globals_1.it)('returns independent item copies', async () => {
        const first = await connection.searchItems(types_1.ContextValue.TABLE);
        first[0].label = 'changed';
        const second = await connection.searchItems(types_1.ContextValue.TABLE);
        (0, globals_1.expect)(second[0].label).toBe('TABLES');
    });
    (0, globals_1.it)('limits returned copies without truncating the cached catalog', async () => {
        const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
        const key = JSON.stringify([types_1.ContextValue.TABLE, '', {}]);
        connection.fallbackCompletionCache = new Map([[key, Promise.resolve(catalog)]]);
        const limited = await connection.searchItems(types_1.ContextValue.TABLE, '', {}, 501);
        const cachedCatalog = await connection.fallbackCompletionCache.get(key);
        (0, globals_1.expect)(limited).toHaveLength(501);
        (0, globals_1.expect)(cachedCatalog).toHaveLength(72000);
        (0, globals_1.expect)(driver.searchItems).not.toHaveBeenCalled();
    });
    (0, globals_1.it)('stores only bounded typed-search results in the request cache', async () => {
        const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
        driver.searchItems = globals_1.jest.fn(async () => catalog);
        const limited = await connection.searchItems(types_1.ContextValue.TABLE, 'TABLE_', {}, 501);
        const cached = await connection.completionCache.get(JSON.stringify([types_1.ContextValue.TABLE, 'TABLE_', {}]));
        (0, globals_1.expect)(limited).toHaveLength(501);
        (0, globals_1.expect)(cached).toHaveLength(501);
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(1);
    });
    (0, globals_1.it)('stops scanning cached catalog after enough matching suggestions', async () => {
        const catalog = Array.from({ length: 72000 }, (_, index) => ({ label: `TABLE_${index}` }));
        const key = JSON.stringify([types_1.ContextValue.TABLE, '', {}]);
        connection.fallbackCompletionCache = new Map([[key, Promise.resolve(catalog)]]);
        const matches = await connection.searchItems(types_1.ContextValue.TABLE, 'TABLE_', {}, 501);
        (0, globals_1.expect)(matches).toHaveLength(501);
        (0, globals_1.expect)(matches[500].label).toBe('TABLE_500');
        (0, globals_1.expect)(driver.searchItems).not.toHaveBeenCalled();
    });
    (0, globals_1.it)('retries failures rather than caching them', async () => {
        driver.searchItems.mockRejectedValueOnce(new Error('temporary failure'));
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE)).rejects.toThrow('temporary failure');
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE)).resolves.toEqual([{ label: 'TABLES' }]);
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(2);
    });
    (0, globals_1.it)('clears searches and static completions on close', async () => {
        await connection.searchItems(types_1.ContextValue.TABLE);
        await connection.getStaticCompletions();
        await connection.getStaticCompletions();
        await connection.close();
        await connection.searchItems(types_1.ContextValue.TABLE);
        await connection.getStaticCompletions();
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(2);
        (0, globals_1.expect)(driver.getStaticCompletions).toHaveBeenCalledTimes(2);
    });
    (0, globals_1.it)('serves the previous search cache until schema and table warm-up succeeds', async () => {
        await connection.searchItems(types_1.ContextValue.TABLE, 'CACHED');
        await connection.connect();
        await connection.close();
        let resolveSchemas;
        let resolveTables;
        driver.searchItems = globals_1.jest.fn((itemType, search) => {
            if (itemType === types_1.ContextValue.SCHEMA)
                return new Promise(resolve => { resolveSchemas = resolve; });
            if (itemType === types_1.ContextValue.TABLE && search === '')
                return new Promise(resolve => { resolveTables = resolve; });
            return Promise.resolve([{ label: 'FRESH' }]);
        });
        connection = new connection_1.default({ id: `cache-test-${connectionId}`, driver: 'cache-test' }, globals_1.jest.fn());
        await connection.connect();
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'TABLES' }]);
        (0, globals_1.expect)(driver.searchItems).not.toHaveBeenCalledWith(types_1.ContextValue.TABLE, 'CACHED', globals_1.expect.anything());
        resolveSchemas([{ label: 'PUBLIC' }]);
        resolveTables([{ label: 'FRESH_TABLE' }]);
        await new Promise(resolve => setTimeout(resolve, 0));
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'FRESH' }]);
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledWith(types_1.ContextValue.TABLE, 'CACHED', {});
    });
    (0, globals_1.it)('retains the previous cache when schema and table warm-up fails', async () => {
        await connection.searchItems(types_1.ContextValue.TABLE, 'CACHED');
        await connection.connect();
        await connection.close();
        driver.searchItems = globals_1.jest.fn((itemType) => {
            if (itemType === types_1.ContextValue.SCHEMA)
                return Promise.reject(new Error('warm-up failed'));
            return Promise.resolve([{ label: 'FRESH_TABLE' }]);
        });
        connection = new connection_1.default({ id: `cache-test-${connectionId}`, driver: 'cache-test' }, globals_1.jest.fn());
        await connection.connect();
        await new Promise(resolve => setTimeout(resolve, 0));
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE, 'CACHED')).resolves.toEqual([{ label: 'TABLES' }]);
        (0, globals_1.expect)(driver.searchItems).not.toHaveBeenCalledWith(types_1.ContextValue.TABLE, 'CACHED', globals_1.expect.anything());
    });
    (0, globals_1.it)('restores warmed schema and table suggestions from disk after a server restart', async () => {
        driver.searchItems = globals_1.jest.fn(async (itemType) => [
            { label: itemType === types_1.ContextValue.SCHEMA ? 'PUBLIC' : 'TABLES' },
        ]);
        await connection.connect();
        await new Promise(resolve => setTimeout(resolve, 0));
        await connection_1.default.persistenceQueue;
        connection_1.default.completionSnapshots.clear();
        connection_1.default.completionSnapshotsLoaded = false;
        driver.searchItems = globals_1.jest.fn(async () => [{ label: 'NETWORK_RESULT' }]);
        connection = new connection_1.default({ id: `cache-test-${connectionId}`, driver: 'cache-test' }, globals_1.jest.fn());
        await (0, globals_1.expect)(connection.searchItems(types_1.ContextValue.TABLE, 'TAB')).resolves.toEqual([{ label: 'TABLES' }]);
        (0, globals_1.expect)(driver.searchItems).not.toHaveBeenCalled();
    });
    (0, globals_1.it)('keeps the previous cache file when a snapshot exceeds the persistence limit', async () => {
        const previousCache = '{"version":1,"snapshots":[{"id":"previous"}]}';
        fs_1.default.writeFileSync(cachePath, previousCache, 'utf8');
        connection_1.default.completionSnapshots.set('oversized-cache-test', new Map([
            [JSON.stringify([types_1.ContextValue.TABLE, '']), Promise.resolve([{ label: 'A'.repeat(100) }])],
        ]));
        const maxBytes = connection_1.default.maxPersistedCompletionCacheBytes;
        connection_1.default.maxPersistedCompletionCacheBytes = 1;
        try {
            await connection.persistCompletionSnapshot();
            (0, globals_1.expect)(fs_1.default.readFileSync(cachePath, 'utf8')).toBe(previousCache);
        }
        finally {
            connection_1.default.maxPersistedCompletionCacheBytes = maxBytes;
        }
    });
    (0, globals_1.it)('does not let a pre-reset failure evict a newer request', async () => {
        let rejectPending;
        driver.searchItems.mockImplementationOnce(() => new Promise((_resolve, reject) => {
            rejectPending = reject;
        }));
        const oldRequest = connection.searchItems(types_1.ContextValue.TABLE);
        const oldFailure = (0, globals_1.expect)(oldRequest).rejects.toThrow('old request');
        await connection.close();
        await connection.searchItems(types_1.ContextValue.TABLE);
        rejectPending(new Error('old request'));
        await oldFailure;
        await connection.searchItems(types_1.ContextValue.TABLE);
        (0, globals_1.expect)(driver.searchItems).toHaveBeenCalledTimes(2);
    });
    (0, globals_1.it)('rejects a driver that is not registered', () => {
        (0, globals_1.expect)(() => new connection_1.default({ driver: 'missing-driver' }, globals_1.jest.fn())).toThrow();
    });
    (0, globals_1.it)('clears prompted passwords when closing', async () => {
        driver.credentials = { askForPassword: true, password: 'temporary' };
        await connection.close();
        (0, globals_1.expect)(driver.credentials.password).toBeUndefined();
    });
    (0, globals_1.it)('preserves a saved password when closing', async () => {
        driver.credentials = { password: 'saved' };
        await connection.close();
        (0, globals_1.expect)(driver.credentials.password).toBe('saved');
    });
    (0, globals_1.it)('returns an empty tree if the driver has no tree provider', async () => {
        await (0, globals_1.expect)(connection.getChildrenForItem({ item: {} })).resolves.toEqual([]);
    });
    (0, globals_1.it)('delegates tree lookups to supported drivers', async () => {
        const params = { item: { label: 'Schemas' } };
        driver.getChildrenForItem = globals_1.jest.fn(async () => [{ label: 'PUBLIC' }]);
        await (0, globals_1.expect)(connection.getChildrenForItem(params)).resolves.toEqual([{ label: 'PUBLIC' }]);
        (0, globals_1.expect)(driver.getChildrenForItem).toHaveBeenCalledWith(params);
    });
    (0, globals_1.it)('serializes the connection ID without an undefined credential overriding it', () => {
        driver.credentials = { id: undefined, name: 'Test', driver: 'cache-test', server: 'localhost', database: 'test' };
        (0, globals_1.expect)(connection.serialize().id).toBe(connection.getId());
        (0, globals_1.expect)(typeof connection.serialize().id).toBe('string');
    });
    (0, globals_1.it)('supplies required IDs on error results without a request ID', async () => {
        driver.credentials = { id: 'test-connection', driver: 'cache-test' };
        driver.query = globals_1.jest.fn(async () => { throw new Error('Query failed'); });
        const [result] = await connection.query('SELECT broken');
        (0, globals_1.expect)(result.error).toBe(true);
        (0, globals_1.expect)(result.requestId).toEqual(globals_1.expect.any(String));
        (0, globals_1.expect)(result.connId).toBe('test-connection');
    });
});
//# sourceMappingURL=connection.test.js.map