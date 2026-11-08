jest.mock('vscode', () => ({
  window: { showWarningMessage: jest.fn() }, workspace: {}, commands: {}, Uri: class {}, ThemeIcon: class {},
}), { virtual: true });
jest.mock('@sqltools/plugins/connection-manager/explorer', () => ({
  ConnectionExplorer: class {}, SidebarItem: class {}, SidebarConnection: class {},
}));
jest.mock('@sqltools/plugins/connection-manager/webview/results', () => ({ __esModule: true, default: class {} }));
jest.mock('@sqltools/plugins/connection-manager/webview/settings', () => ({ __esModule: true, default: class {} }));
jest.mock('@sqltools/vscode/context', () => ({ __esModule: true, default: {} }));
jest.mock('@sqltools/vscode/utils', () => ({}));
jest.mock('@sqltools/vscode/utils/quickPick', () => ({}));
jest.mock('@sqltools/vscode/utils/query', () => ({}));
jest.mock('@sqltools/util/config-manager', () => ({ __esModule: true, default: {
  'queryParams.enableReplace': false, get: jest.fn(),
} }));
jest.mock('@sqltools/log/src', () => ({
  __esModule: true, default: {}, createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../codelens/extension', () => ({ __esModule: true, default: class {} }));
jest.mock('./dependency-manager/extension', () => ({ __esModule: true, default: class {} }));
jest.mock('./status-bar', () => ({ __esModule: true, default: {} }));
jest.mock('./attached-files', () => ({}));
jest.mock('./extension-util', () => ({}));
jest.mock('./generate-ddl', () => ({}));
jest.mock('./generate-ddl-editor', () => ({}));

import { ConnectionManagerPlugin } from './extension';
import Config from '@sqltools/util/config-manager';
import { window } from 'vscode';

describe('results query failure handling', () => {
  const plugin = ConnectionManagerPlugin.instance();
  const connection = { id: 'connection', name: 'Test', driver: 'PostgreSQL' };
  const view = { requestId: 'request', sendMessage: jest.fn(), updateResults: jest.fn() };
  const error = new Error('SQL execution blocked by pattern 1.');
  const errorHandler = jest.fn();
  const sendRequest = jest.fn();
  const open = jest.fn();
  const getIfExists = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (Config.get as jest.Mock).mockReturnValue([]);
    getIfExists.mockReturnValue(view);
    open.mockResolvedValue(view);
    sendRequest.mockRejectedValue(error);
    Reflect.set(plugin, 'resultsWebview', { getIfExists });
    Reflect.set(plugin, 'explorer', { getActive: jest.fn().mockResolvedValue(connection) });
    Reflect.set(plugin, 'client', { sendRequest });
    Reflect.set(plugin, 'errorHandler', errorHandler);
    Reflect.set(plugin, '_connect', jest.fn().mockResolvedValue(connection));
    Reflect.set(plugin, '_openResultsWebview', open);
  });

  it('warns without opening results or sending a blocked query', async () => {
    (Config.get as jest.Mock).mockReturnValue(['drop\\s+table']);
    getIfExists.mockReturnValue(undefined);
    await plugin['ext_executeQuery']('SELECT 1; DROP TABLE s.t');
    expect(open).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage).toHaveBeenCalledWith('SQL execution blocked by pattern 1.');
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('clears loading on an existing results view when a rerun is blocked', async () => {
    (Config.get as jest.Mock).mockReturnValue(['drop\\s+table']);
    await plugin['ext_executeQuery']('DROP TABLE s.t', { requestId: 'request' });
    expect(open).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(view.sendMessage).toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('checks SQL after parameter substitution', async () => {
    (Config.get as jest.Mock).mockReturnValue(['drop\\s+table']);
    const replaceParams = plugin['replaceParams'];
    Reflect.set(plugin, 'replaceParams', jest.fn().mockResolvedValue('DROP TABLE s.t'));
    try {
      await plugin['ext_executeQuery']('DROP :object s.t');
      expect(open).not.toHaveBeenCalled();
      expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.set(plugin, 'replaceParams', replaceParams);
    }
  });

  it('reports invalid regex as an error without opening a results view', async () => {
    (Config.get as jest.Mock).mockReturnValue(['(']);
    await plugin['ext_executeQuery']('SELECT 1');
    expect(open).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledWith('Error fetching records.', expect.objectContaining({
      message: expect.stringContaining('Invalid SQL blocking pattern 1'),
    }));
  });

  it('does not block patterns appearing only in comments or literals', async () => {
    (Config.get as jest.Mock).mockReturnValue(['drop\\s+table']);
    sendRequest.mockResolvedValue([]);
    await plugin['ext_executeQuery']("SELECT 'DROP TABLE s.t'; -- DROP TABLE s.t");
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.updateResults).toHaveBeenCalledWith([]);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('reports a blocked query once and stops the matching view loading', async () => {
    await plugin['ext_executeQuery']('DROP TABLE s.t');
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'query', errorHandling: 'client', args: ['DROP TABLE s.t', { requestId: 'request' }],
    }));
    expect(view.sendMessage).toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith('Error fetching records.', error);
    expect(view.updateResults).not.toHaveBeenCalled();
  });

  it('stops a reused view loading when preparation fails before opening', async () => {
    const preparationError = new Error('Connection unavailable');
    Reflect.set(plugin, '_connect', jest.fn().mockRejectedValue(preparationError));
    await plugin['ext_executeQuery']('SELECT 1', { requestId: 'request' });
    expect(open).not.toHaveBeenCalled();
    expect(view.sendMessage).toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(errorHandler).toHaveBeenCalledWith('Error fetching records.', preparationError);
  });

  it('stops pagination loading and reports the error once', async () => {
    Reflect.set(plugin, '_getTable', jest.fn().mockResolvedValue({ label: 'table' }));
    await plugin['ext_showRecords'](undefined, { requestId: 'request', page: 1 });
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'showRecords', errorHandling: 'client',
    }));
    expect(view.sendMessage).toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it('stops loading when describing a table fails', async () => {
    Reflect.set(plugin, '_getTable', jest.fn().mockResolvedValue({ label: 'table' }));
    await plugin['ext_describeTable']();
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'describeTable', errorHandling: 'client',
    }));
    expect(view.sendMessage).toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it('preserves server-side notifications for grid edit failures', async () => {
    await expect(plugin['ext_applyResultEdits']([])).rejects.toBe(error);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: 'applyEdits', errorHandling: undefined, args: [[], {}],
    }));
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('updates results normally after a successful query', async () => {
    sendRequest.mockResolvedValue([]);
    await plugin['ext_executeQuery']('SELECT 1');
    expect(view.updateResults).toHaveBeenCalledWith([]);
    expect(view.sendMessage).not.toHaveBeenCalledWith('SET_STATE', { loading: false });
    expect(errorHandler).not.toHaveBeenCalled();
  });
});
