import { ContextValue, IConnection, NSDatabase } from '@sqltools/types';
import ConnectionManagerPlugin from './language-server';
import connectionStateCache from './cache/connections-state.model';
import { GenerateTableDDLRequest } from './contracts';
import Handlers from './cache/handlers';

jest.mock('@sqltools/language-server/src/connection', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@sqltools/util/config-manager', () => ({ __esModule: true, default: {} }));
jest.mock('@sqltools/log/src', () => ({ createLogger: () => ({ error: jest.fn(), info: jest.fn() }) }));
jest.mock('./cache/connections-state.model', () => ({
  __esModule: true, default: { get: jest.fn() }, ACTIVE_CONNECTIONS_KEY: 'activeConnections',
}));
jest.mock('./cache/handlers', () => ({
  __esModule: true, default: { QuerySuccess: jest.fn() },
}));

const conn: IConnection = {
  id: 'ddl-selected', name: 'Db2', driver: 'Db2', username: 'test', isConnected: true, isActive: true,
};
const table: NSDatabase.ITable = {
  label: 'Employees', schema: 'App', database: 'DB', type: ContextValue.TABLE, isView: false,
};

describe('typed GenerateTableDDL request', () => {
  const plugin = new ConnectionManagerPlugin();
  const handler = plugin['generateTableDDLHandler'];
  let selected: { generateTableDDL: jest.Mock };
  let previous: { generateTableDDL: jest.Mock };

  beforeEach(() => {
    selected = { generateTableDDL: jest.fn().mockResolvedValue('CREATE TABLE "App"."Employees" ("ID" INTEGER);') };
    previous = { generateTableDDL: jest.fn() };
    (connectionStateCache.get as jest.Mock).mockResolvedValue({
      'ddl-selected': selected, 'previously-active': previous,
    });
    jest.clearAllMocks();
  });

  it('has a separate string-returning request, not a result-grid command', () => {
    expect(GenerateTableDDLRequest.method).toBe('connection/GenerateTableDDLRequest');
  });

  it('uses the requested connection, not the last active one', async () => {
    await expect(handler({ conn, table })).resolves.toBe('CREATE TABLE "App"."Employees" ("ID" INTEGER);');
    expect(selected.generateTableDDL).toHaveBeenCalledWith(table);
    expect(previous.generateTableDDL).not.toHaveBeenCalled();
    expect(Handlers.QuerySuccess).not.toHaveBeenCalled();
  });

  it('rejects an absent connection', async () => {
    (connectionStateCache.get as jest.Mock).mockResolvedValue({});
    await expect(handler({ conn, table })).rejects.toThrow('Connection not found');
  });

  it('propagates catalog and unsupported-driver errors rather than returning empty SQL', async () => {
    selected.generateTableDDL.mockRejectedValue(new Error('Generate DDL is not supported by this driver'));
    await expect(handler({ conn, table })).rejects.toThrow('not supported');
    expect(Handlers.QuerySuccess).not.toHaveBeenCalled();
  });
});
