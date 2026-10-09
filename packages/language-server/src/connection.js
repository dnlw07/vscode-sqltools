"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("@sqltools/types");
const ls_decorate_exception_1 = __importDefault(require("@sqltools/util/decorators/ls-decorate-exception"));
const connection_1 = require("@sqltools/util/connection");
const config_manager_1 = __importDefault(require("@sqltools/util/config-manager"));
const internal_id_1 = __importDefault(require("@sqltools/util/internal-id"));
const context_1 = __importDefault(require("./context"));
const driver_not_installed_1 = __importDefault(require("./exception/driver-not-installed"));
const src_1 = require("@sqltools/log/src");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const path_2 = require("@sqltools/util/path");
const log = (0, src_1.createLogger)('conn');
class Connection {
    credentials;
    static completionSnapshots = new Map();
    static maxCompletionSnapshots = 50;
    static maxPersistedCompletionCacheBytes = 25 * 1024 * 1024;
    static completionSnapshotsLoaded = false;
    static persistenceQueue = Promise.resolve();
    static completionSnapshotPath = (0, path_2.getDataPath)('autosuggestions.json');
    connected = false;
    conn;
    completionCache = new Map();
    fallbackCompletionCache;
    constructor(credentials, getWorkspaceFolders) {
        this.credentials = credentials;
        const DriverClass = context_1.default.drivers.get(credentials.driver);
        if (!DriverClass) {
            throw new driver_not_installed_1.default(credentials.driver);
        }
        this.conn = new DriverClass(this.credentials, getWorkspaceFolders);
        Connection.loadCompletionSnapshots();
        this.fallbackCompletionCache = Connection.completionSnapshots.get(this.getCompletionCacheId());
    }
    decorateException = (e) => {
        e = (0, ls_decorate_exception_1.default)(e, { conn: this.credentials });
        return Promise.reject(e);
    };
    needsPassword() {
        return this.conn.credentials.askForPassword;
    }
    async connect() {
        if (!this.connected && this.conn.checkDependencies) {
            await this.conn.checkDependencies();
        }
        if (typeof this.conn.testConnection === 'function')
            await this.conn.testConnection().catch(this.decorateException);
        else
            await this.query('SELECT 1;', { throwIfError: true });
        this.connected = true;
        void this.warmCompletionCache();
    }
    setPassword(password) {
        this.conn.credentials.password = password;
    }
    getPassword() {
        return this.conn.credentials.password;
    }
    isConnected() {
        return this.connected;
    }
    close() {
        if (this.connected) {
            const snapshot = new Map(this.fallbackCompletionCache || []);
            this.completionCache.forEach((value, key) => snapshot.set(key, value));
            this.saveCompletionSnapshot(snapshot);
        }
        this.fallbackCompletionCache = undefined;
        this.completionCache = new Map();
        if (this.needsPassword())
            this.conn.credentials.password = undefined;
        this.connected = false;
        return this.conn.close();
    }
    async describeTable(table, opt) {
        const info = await this.conn.describeTable(table, opt).catch(this.decorateException);
        if (info[0]) {
            info[0].label = `Table ${table.label}`;
        }
        return info;
    }
    async showRecords(table, opt) {
        const { pageSize, page, requestId } = opt;
        const limit = pageSize || this.conn.credentials.previewLimit || (config_manager_1.default.results && config_manager_1.default.results.limit) || 50;
        const [records] = await this.conn.showRecords(table, { limit, page, requestId }).catch(this.decorateException);
        if (records) {
            records.label = [
                Math.max(records.total || 0, records.results.length, 0),
                'records on',
                `'${table.label}'`,
                'table'
            ].join(' ');
        }
        return [records];
    }
    query(query, opt = {}) {
        return this.conn.query(query, opt)
            .catch(this.decorateException)
            .catch((e) => {
            log.error('%O', e);
            if (opt.throwIfError)
                throw e;
            let message = '';
            if (typeof e === 'string') {
                message = e;
            }
            else if (e.message) {
                message = e.message;
            }
            else {
                message = JSON.stringify(e);
            }
            return [{
                    requestId: opt.requestId ?? (0, internal_id_1.default)(),
                    resultId: (0, internal_id_1.default)(),
                    connId: this.getId(),
                    cols: [],
                    error: true,
                    messages: [{ message, date: new Date() }],
                    query,
                    results: [],
                }];
        });
    }
    getName() {
        return this.conn.credentials.name;
    }
    getServer() {
        return this.conn.credentials.server;
    }
    getPort() {
        return this.conn.credentials.port;
    }
    getUsername() {
        return this.conn.credentials.username;
    }
    getDatabase() {
        return this.conn.credentials.database;
    }
    getDriver() {
        return this.conn.credentials.driver;
    }
    getId() {
        const id = (0, connection_1.getConnectionId)(this.conn.credentials);
        if (id === null)
            throw new Error('Unable to determine connection ID.');
        return id;
    }
    serialize() {
        return {
            ...this.conn.credentials,
            id: this.getId(),
            isConnected: this.isConnected(),
        };
    }
    static async testConnection(credentials, getWorkspaceFolders) {
        const testConn = new Connection(credentials, getWorkspaceFolders);
        await testConn.connect();
        await testConn.close();
        return true;
    }
    getChildrenForItem(params) {
        if (typeof this.conn.getChildrenForItem !== 'function')
            return Promise.resolve([]);
        return this.conn.getChildrenForItem(params);
    }
    getDefinitionForItem(params) {
        if (this.conn.getDefinitionForItem && typeof this.conn.getDefinitionForItem === 'function') {
            return this.conn.getDefinitionForItem(params);
        }
        return `-- Not supported by ${this.getDriver()}`;
    }
    async generateTableDDL(table) {
        if (!table || table.type !== types_1.ContextValue.TABLE || !table.label || !table.label.trim()) {
            throw new Error('Generate DDL requires a table.');
        }
        if (!this.isConnected()) {
            throw new Error('Connect to the database before generating DDL.');
        }
        if (typeof this.conn.generateTableDDL !== 'function') {
            throw new Error(`Generate DDL is not supported by ${this.getDriver()}.`);
        }
        const ddl = await this.conn.generateTableDDL(table).catch(this.decorateException);
        if (typeof ddl !== 'string' || !ddl.trim()) {
            throw new Error(`No table DDL was returned by ${this.getDriver()}.`);
        }
        return ddl;
    }
    getInsertQuery(params) {
        if (this.conn.getInsertQuery && typeof this.conn.getInsertQuery === 'function') {
            return this.conn.getInsertQuery(params);
        }
        const { item, columns } = params;
        let insertQuery = `INSERT INTO ${item.label} (${columns.map((col) => col.label).join(', ')}) VALUES (`;
        columns.forEach((col, index) => {
            insertQuery = insertQuery.concat(`'\${${index + 1}:${col.label}:${col.dataType}}', `);
        });
        return insertQuery;
    }
    cacheCompletion(key, load, cache = this.completionCache, useFallback = true) {
        const cached = cache.get(key) || (useFallback && this.fallbackCompletionCache && this.fallbackCompletionCache.get(key));
        if (cached)
            return cached;
        const pending = Promise.resolve().then(load).catch(error => {
            if (cache.get(key) === pending)
                cache.delete(key);
            const snapshot = Connection.completionSnapshots.get(this.getCompletionCacheId());
            if (snapshot && snapshot.get(key) === pending)
                snapshot.delete(key);
            throw error;
        });
        if (cache.size >= 256) {
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined)
                cache.delete(firstKey);
        }
        cache.set(key, pending);
        return pending;
    }
    searchItemsWithCache(itemType, search, extraParams, cache, useFallback, maxResults) {
        const searchItems = this.conn.searchItems;
        if (typeof searchItems !== 'function')
            return Promise.resolve([]);
        const key = this.completionKey(itemType, search, extraParams);
        const cached = cache.get(key) || (useFallback && this.fallbackCompletionCache && this.fallbackCompletionCache.get(key));
        if (!cached && useFallback && search && (itemType === types_1.ContextValue.TABLE || itemType === types_1.ContextValue.SCHEMA)) {
            const unfiltered = this.fallbackCompletionCache && this.fallbackCompletionCache.get(this.completionKey(itemType, '', extraParams));
            if (unfiltered) {
                const normalizedSearch = search.toUpperCase();
                return unfiltered.then(items => {
                    const matches = [];
                    for (const item of items) {
                        if (item.label.toUpperCase().includes(normalizedSearch)) {
                            matches.push(item);
                            if (maxResults && matches.length >= maxResults)
                                break;
                        }
                    }
                    return matches.map(item => ({ ...item }));
                });
            }
        }
        const load = () => Promise.resolve(searchItems.call(this.conn, itemType, search, extraParams))
            .then(items => maxResults ? (items || []).slice(0, maxResults) : items);
        return this.cacheCompletion(key, load, cache, useFallback)
            .then(items => {
            const allItems = items || [];
            const results = maxResults ? allItems.slice(0, maxResults) : allItems;
            return results.map(item => ({ ...item }));
        });
    }
    completionKey(itemType, search, extraParams) {
        return JSON.stringify([itemType, search, extraParams], (_key, value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return value;
            return Object.keys(value).sort().reduce((sorted, property) => {
                sorted[property] = value[property];
                return sorted;
            }, {});
        });
    }
    searchItems(itemType, search = '', extraParams = {}, maxResults) {
        return this.searchItemsWithCache(itemType, search, extraParams, this.completionCache, true, maxResults);
    }
    getStaticCompletions = () => {
        const getStaticCompletions = this.conn.getStaticCompletions;
        if (typeof getStaticCompletions !== 'function')
            return Promise.resolve({});
        return this.cacheCompletion('static', () => getStaticCompletions.call(this.conn))
            .then(items => Object.keys(items).reduce((copy, key) => {
            copy[key] = { ...items[key] };
            return copy;
        }, {}));
    };
    saveCompletionSnapshot(cache) {
        const id = this.getCompletionCacheId();
        Connection.completionSnapshots.delete(id);
        Connection.completionSnapshots.set(id, cache);
        if (Connection.completionSnapshots.size > Connection.maxCompletionSnapshots) {
            const oldestId = Connection.completionSnapshots.keys().next().value;
            if (oldestId !== undefined)
                Connection.completionSnapshots.delete(oldestId);
        }
    }
    static loadCompletionSnapshots() {
        if (Connection.completionSnapshotsLoaded)
            return;
        Connection.completionSnapshotsLoaded = true;
        try {
            if (!fs_1.default.existsSync(Connection.completionSnapshotPath))
                return;
            const stored = JSON.parse(fs_1.default.readFileSync(Connection.completionSnapshotPath, 'utf8'));
            if (stored.version !== 1 || !Array.isArray(stored.snapshots)) {
                throw new Error('Unsupported autosuggestion cache format.');
            }
            for (const snapshot of stored.snapshots.slice(-Connection.maxCompletionSnapshots)) {
                if (typeof snapshot.id !== 'string' || !Array.isArray(snapshot.items))
                    continue;
                const cache = new Map();
                for (const entry of snapshot.items) {
                    if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
                        cache.set(entry[0], Promise.resolve(entry[1]));
                    }
                }
                Connection.completionSnapshots.set(snapshot.id, cache);
            }
        }
        catch (error) {
            log.error('Failed to load autosuggestion cache: %O', error);
        }
    }
    persistCompletionSnapshot() {
        const isPersistableKey = (key) => {
            const [itemType, search] = JSON.parse(key);
            return search === '' && (itemType === types_1.ContextValue.SCHEMA || itemType === types_1.ContextValue.TABLE);
        };
        const persist = async () => {
            const snapshots = await Promise.all(Array.from(Connection.completionSnapshots.entries())
                .map(async ([snapshotId, snapshotCache]) => ({
                id: snapshotId,
                items: await Promise.all(Array.from(snapshotCache.entries())
                    .filter(([key]) => isPersistableKey(key))
                    .map(async ([key, value]) => {
                    try {
                        return [key, await value];
                    }
                    catch (_error) {
                        return undefined;
                    }
                }))
                    .then(items => items.filter(Boolean)),
            })));
            const payload = JSON.stringify({ version: 1, snapshots });
            if (Buffer.byteLength(payload, 'utf8') > Connection.maxPersistedCompletionCacheBytes) {
                log.error('Autosuggestion cache exceeds the persistence size limit; keeping the previous cache file.');
                return;
            }
            const destination = Connection.completionSnapshotPath;
            const temporary = path_1.default.join(path_1.default.dirname(destination), `${path_1.default.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
            fs_1.default.writeFileSync(temporary, payload, 'utf8');
            try {
                fs_1.default.renameSync(temporary, destination);
            }
            catch (error) {
                try {
                    fs_1.default.unlinkSync(temporary);
                }
                catch (cleanupError) {
                    log.error('Failed to remove temporary autosuggestion cache file: %O', cleanupError);
                }
                throw error;
            }
        };
        const queued = Connection.persistenceQueue.then(persist);
        Connection.persistenceQueue = queued.catch(error => {
            log.error('Failed to save autosuggestion cache: %O', error);
        });
        return Connection.persistenceQueue;
    }
    getCompletionCacheId() {
        const id = (0, connection_1.getConnectionId)(this.credentials);
        if (id === null)
            throw new Error('Unable to determine connection ID.');
        return (0, crypto_1.createHash)('sha256').update(id).digest('hex');
    }
    async warmCompletionCache() {
        const warmingCache = new Map();
        try {
            await Promise.all([
                this.searchItemsWithCache(types_1.ContextValue.SCHEMA, '', {}, warmingCache, false),
                this.searchItemsWithCache(types_1.ContextValue.TABLE, '', {}, warmingCache, false),
            ]);
            if (!this.connected)
                return;
            const replacementCache = new Map(warmingCache);
            this.completionCache.forEach((value, key) => {
                if (!replacementCache.has(key))
                    replacementCache.set(key, value);
            });
            this.completionCache = replacementCache;
            this.fallbackCompletionCache = undefined;
            this.saveCompletionSnapshot(replacementCache);
            await this.persistCompletionSnapshot();
        }
        catch (error) {
            log.error('Failed to warm schema and table completion cache: %O', error);
        }
    }
    getCompletionsForRawQuery(text, currentOffset) {
        if (typeof this.conn.getCompletionsForRawQuery !== 'function')
            return Promise.resolve(null);
        return this.conn.getCompletionsForRawQuery(text, currentOffset);
    }
    applyEdits(edits, opt = {}) {
        if (typeof this.conn.applyEdits !== 'function') {
            return Promise.resolve({ success: false, error: `Editing result grids is not supported by ${this.getDriver()}.` });
        }
        return this.conn.applyEdits(edits, opt).catch(e => ({ success: false, error: e.message || String(e) }));
    }
}
exports.default = Connection;
//# sourceMappingURL=connection.js.map