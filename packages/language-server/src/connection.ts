import { NSDatabase, IConnectionDriver, IConnection, MConnectionExplorer, ContextValue, InternalID, IQueryOptions } from '@sqltools/types';
import decorateLSException from '@sqltools/util/decorators/ls-decorate-exception';
import { getConnectionId } from '@sqltools/util/connection';
import ConfigRO from '@sqltools/util/config-manager';
import generateId from '@sqltools/util/internal-id';
import LSContext from './context';
import { IConnection as LSIconnection, CompletionItem } from 'vscode-languageserver';
import DriverNotInstalledError from './exception/driver-not-installed';
import { createLogger } from '@sqltools/log/src';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDataPath } from '@sqltools/util/path';

const log = createLogger('conn');

type CompletionCache = Map<string, Promise<any>>;

export default class Connection {
  private static readonly completionSnapshots = new Map<string, CompletionCache>();
  private static readonly maxCompletionSnapshots = 50;
  private static readonly maxPersistedCompletionCacheBytes = 10 * 1024 * 1024;
  private static completionSnapshotsLoaded = false;
  private static persistenceQueue: Promise<void> = Promise.resolve();
  private static readonly completionSnapshotPath = getDataPath('autosuggestions.json');

  private connected: boolean = false;
  private conn: IConnectionDriver;
  private completionCache: CompletionCache = new Map();
  private fallbackCompletionCache: CompletionCache;
  constructor(private credentials: IConnection, getWorkspaceFolders: LSIconnection['workspace']['getWorkspaceFolders']) {
    const DriverClass = LSContext.drivers.get(credentials.driver);
    if (!DriverClass) {
      throw new DriverNotInstalledError(credentials.driver);
    }

    this.conn = new DriverClass(this.credentials, getWorkspaceFolders);
    Connection.loadCompletionSnapshots();
    this.fallbackCompletionCache = Connection.completionSnapshots.get(this.getCompletionCacheId());
  }

  private decorateException = (e: Error) => {
    e = decorateLSException(e, { conn: this.credentials });
    return Promise.reject(e);
  }

  public needsPassword() {
    return this.conn.credentials.askForPassword;
  }

  public async connect() {
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

  public setPassword(password: string) {
    this.conn.credentials.password = password;
  }

  public getPassword() {
    return this.conn.credentials.password;
  }
  public isConnected() {
    return this.connected;
  }

  public close() {
    if (this.connected) {
      const snapshot = new Map(this.fallbackCompletionCache || []);
      this.completionCache.forEach((value, key) => snapshot.set(key, value));
      this.saveCompletionSnapshot(snapshot);
    }
    this.fallbackCompletionCache = undefined;
    this.completionCache = new Map();
    if (this.needsPassword()) this.conn.credentials.password = undefined;
    this.connected = false;
    return this.conn.close();
  }

  public async describeTable(table: NSDatabase.ITable, opt: { requestId: InternalID }) {
    const info = await this.conn.describeTable(table, opt).catch(this.decorateException);

    if (info[0]) {
      info[0].label = `Table ${table.label}`;
    }
    return info;
  }
  public async showRecords(table: NSDatabase.ITable, opt: { requestId: InternalID; page: number; pageSize?: number }) {
    const { pageSize, page, requestId } = opt;
    const limit = pageSize || this.conn.credentials.previewLimit || (ConfigRO.results && ConfigRO.results.limit) || 50;

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

  public query(query: string, opt: IQueryOptions & { throwIfError?: boolean } = {}): Promise<NSDatabase.IResult[]> {
    return this.conn.query(query, opt)
      .catch(this.decorateException)
      .catch((e) => {
        log.error('%O', e);
        if (opt.throwIfError) throw e;
        let message = '';
        if (typeof e === 'string') {
          message = e;
        } else if (e.message) {
          message = e.message;
        } else {
          message = JSON.stringify(e);
        }
        return [{
          requestId: opt.requestId ?? generateId(),
          resultId: generateId(),
          connId: this.getId(),
          cols: [],
          error: true,
          messages: [{ message, date: new Date() }],
          query,
          results: [],
        }];
      });
  }
  public getName() {
    return this.conn.credentials.name;
  }
  public getServer() {
    return this.conn.credentials.server;
  }

  public getPort() {
    return this.conn.credentials.port;
  }
  public getUsername() {
    return this.conn.credentials.username;
  }

  public getDatabase() {
    return this.conn.credentials.database;
  }

  public getDriver() {
    return this.conn.credentials.driver;
  }

  public getId(): string {
    const id = getConnectionId(this.conn.credentials);
    if (id === null) throw new Error('Unable to determine connection ID.');
    return id;
  }

  public serialize(): IConnection {
    return {
      ...this.conn.credentials,
      id: this.getId(),
      isConnected: this.isConnected(),
    };
  }

  public static async testConnection(credentials: IConnection, getWorkspaceFolders: LSIconnection['workspace']['getWorkspaceFolders']) {
    const testConn = new Connection(credentials, getWorkspaceFolders);
    await testConn.connect();
    await testConn.close();
    return true;
  }

  public getChildrenForItem(params: { item: MConnectionExplorer.IChildItem; parent?: MConnectionExplorer.IChildItem }) {
    if (typeof this.conn.getChildrenForItem !== 'function') return Promise.resolve([]);
    return this.conn.getChildrenForItem(params);
  }

  public getDefinitionForItem(params: { item: NSDatabase.DefinableItem; }) {
    if (this.conn.getDefinitionForItem && typeof this.conn.getDefinitionForItem === 'function') {
      return this.conn.getDefinitionForItem(params);
    }
    return `-- Not supported by ${this.getDriver()}`;
  }

  public getInsertQuery(params: { item: NSDatabase.ITable; columns: Array<NSDatabase.IColumn> }) {
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

  private cacheCompletion<T>(key: string, load: () => Promise<T>, cache = this.completionCache, useFallback = true): Promise<T> {
    const cached = cache.get(key) || (useFallback && this.fallbackCompletionCache && this.fallbackCompletionCache.get(key));
    if (cached) return cached;
    const pending = Promise.resolve().then(load).catch(error => {
      if (cache.get(key) === pending) cache.delete(key);
      const snapshot = Connection.completionSnapshots.get(this.getCompletionCacheId());
      if (snapshot && snapshot.get(key) === pending) snapshot.delete(key);
      throw error;
    });
    if (cache.size >= 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, pending);
    return pending;
  }

  private searchItemsWithCache(itemType: ContextValue, search: string, extraParams: {}, cache: CompletionCache, useFallback: boolean) {
    const searchItems = this.conn.searchItems;
    if (typeof searchItems !== 'function') return Promise.resolve([]);
    const key = this.completionKey(itemType, search, extraParams);
    const cached = cache.get(key) || (useFallback && this.fallbackCompletionCache && this.fallbackCompletionCache.get(key));
    if (!cached && useFallback && search && (itemType === ContextValue.TABLE || itemType === ContextValue.SCHEMA)) {
      const unfiltered = this.fallbackCompletionCache && this.fallbackCompletionCache.get(this.completionKey(itemType, '', extraParams));
      if (unfiltered) {
        const normalizedSearch = search.toUpperCase();
        return unfiltered.then(items => items
          .filter(item => item.label.toUpperCase().includes(normalizedSearch))
          .map(item => ({ ...item })));
      }
    }
    return this.cacheCompletion<NSDatabase.SearchableItem[]>(key, () => searchItems.call(this.conn, itemType, search, extraParams), cache, useFallback)
      .then(items => (items || []).map(item => ({ ...item })));
  }

  private completionKey(itemType: ContextValue, search: string, extraParams: {}) {
    return JSON.stringify([itemType, search, extraParams], (_key, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.keys(value).sort().reduce((sorted, property) => {
        sorted[property] = value[property];
        return sorted;
      }, {} as any);
    });
  }

  public searchItems(itemType: ContextValue, search: string = '', extraParams = {}) {
    return this.searchItemsWithCache(itemType, search, extraParams, this.completionCache, true);
  }

  public getStaticCompletions: NonNullable<IConnectionDriver['getStaticCompletions']> = () => {
    const getStaticCompletions = this.conn.getStaticCompletions;
    if (typeof getStaticCompletions !== 'function') return Promise.resolve({} as any);
    return this.cacheCompletion<Awaited<ReturnType<NonNullable<IConnectionDriver['getStaticCompletions']>>>>('static', () => getStaticCompletions.call(this.conn))
      .then(items => Object.keys(items).reduce((copy, key) => {
        copy[key] = { ...items[key] };
        return copy;
      }, {} as typeof items));
  }

  private saveCompletionSnapshot(cache: CompletionCache) {
    const id = this.getCompletionCacheId();
    Connection.completionSnapshots.delete(id);
    Connection.completionSnapshots.set(id, cache);
    if (Connection.completionSnapshots.size > Connection.maxCompletionSnapshots) {
      const oldestId = Connection.completionSnapshots.keys().next().value;
      if (oldestId !== undefined) Connection.completionSnapshots.delete(oldestId);
    }
  }

  private static loadCompletionSnapshots() {
    if (Connection.completionSnapshotsLoaded) return;
    Connection.completionSnapshotsLoaded = true;
    try {
      if (!fs.existsSync(Connection.completionSnapshotPath)) return;
      const stored = JSON.parse(fs.readFileSync(Connection.completionSnapshotPath, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.snapshots)) {
        throw new Error('Unsupported autosuggestion cache format.');
      }
      for (const snapshot of stored.snapshots.slice(-Connection.maxCompletionSnapshots)) {
        if (typeof snapshot.id !== 'string' || !Array.isArray(snapshot.items)) continue;
        const cache: CompletionCache = new Map();
        for (const entry of snapshot.items) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
            cache.set(entry[0], Promise.resolve(entry[1]));
          }
        }
        Connection.completionSnapshots.set(snapshot.id, cache);
      }
    } catch (error) {
      log.error('Failed to load autosuggestion cache: %O', error);
    }
  }

  private persistCompletionSnapshot() {
    const isPersistableKey = (key: string) => {
      const [itemType, search] = JSON.parse(key);
      return search === '' && (itemType === ContextValue.SCHEMA || itemType === ContextValue.TABLE);
    };
    const persist = async () => {
      const snapshots = await Promise.all(Array.from(Connection.completionSnapshots.entries())
        .map(async ([snapshotId, snapshotCache]) => ({
          id: snapshotId,
          items: await Promise.all(Array.from(snapshotCache.entries())
            .filter(([key]) => isPersistableKey(key))
            .map(async ([key, value]) => {
              try {
                return [key, await value] as [string, NSDatabase.SearchableItem[]];
              } catch (_error) {
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
      const temporary = path.join(path.dirname(destination), `${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(temporary, payload, 'utf8');
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch (cleanupError) {
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

  private getCompletionCacheId() {
    const id = getConnectionId(this.credentials);
    if (id === null) throw new Error('Unable to determine connection ID.');
    return createHash('sha256').update(id).digest('hex');
  }

  private async warmCompletionCache() {
    const warmingCache: CompletionCache = new Map();
    try {
      await Promise.all([
        this.searchItemsWithCache(ContextValue.SCHEMA, '', {}, warmingCache, false),
        this.searchItemsWithCache(ContextValue.TABLE, '', {}, warmingCache, false),
      ]);
      if (!this.connected) return;

      const replacementCache = new Map(warmingCache);
      this.completionCache.forEach((value, key) => {
        if (!replacementCache.has(key)) replacementCache.set(key, value);
      });
      this.completionCache = replacementCache;
      this.fallbackCompletionCache = undefined;
      this.saveCompletionSnapshot(replacementCache);
      await this.persistCompletionSnapshot();
    } catch (error) {
      log.error('Failed to warm schema and table completion cache: %O', error);
    }
  }

  public getCompletionsForRawQuery(text: string, currentOffset: number): Promise<CompletionItem[] | null> {
    if (typeof this.conn.getCompletionsForRawQuery !== 'function') return Promise.resolve(null);
    return this.conn.getCompletionsForRawQuery(text, currentOffset);
  }

  public applyEdits(edits: NSDatabase.IResultEdit[], opt: IQueryOptions = {}) {
    if (typeof this.conn.applyEdits !== 'function') {
      return Promise.resolve({ success: false, error: `Editing result grids is not supported by ${this.getDriver()}.` });
    }
    return this.conn.applyEdits(edits, opt).catch(e => ({ success: false, error: e.message || String(e) }));
  }
}
