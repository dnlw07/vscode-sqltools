import { ContextValue, IConnection, NSDatabase } from '@sqltools/types';
import { DismissedError } from '@sqltools/util/exception';
import { generateDDL, selectDDLTarget } from './generate-ddl';

const conn: IConnection = {
  name: 'Db2', driver: 'Db2', id: 'selected', username: 'test', isConnected: true, isActive: true,
};
const table: NSDatabase.ITable = {
  label: 'EMPLOYEES', schema: 'APP', database: 'DB', type: ContextValue.TABLE, isView: false,
};

function selectionDependencies() {
  return {
    connect: jest.fn().mockResolvedValue(conn),
    setConnection: jest.fn().mockResolvedValue(conn),
    pickTable: jest.fn().mockResolvedValue(table),
  };
}

function generationDependencies() {
  return {
    selectTarget: jest.fn().mockResolvedValue({ conn, table }),
    requestDDL: jest.fn().mockResolvedValue('CREATE TABLE "APP"."EMPLOYEES" ("ID" INTEGER);'),
    withProgress: jest.fn(async (_title: string, generate: () => Promise<string>) => generate()),
    openSQL: jest.fn().mockResolvedValue(undefined),
    onError: jest.fn(),
  };
}

describe('Generate DDL selection', () => {
  it('routes a sidebar table to its own connection rather than the active connection', async () => {
    const deps = selectionDependencies();
    deps.connect.mockResolvedValue({ ...conn, id: 'previously-active' });
    expect(await selectDDLTarget({ conn, table }, deps)).toEqual({ conn, table });
    expect(deps.setConnection).toHaveBeenCalledWith(conn);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.pickTable).not.toHaveBeenCalled();
  });

  it('connects and picks a table from that connection for command-palette use', async () => {
    const deps = selectionDependencies();
    expect(await selectDDLTarget({}, deps)).toEqual({ conn, table });
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(deps.pickTable).toHaveBeenCalledWith(conn);
  });

  it('stops before table selection when connection or password selection is cancelled', async () => {
    const deps = selectionDependencies();
    deps.connect.mockResolvedValue(undefined);
    expect(await selectDDLTarget({}, deps)).toBeUndefined();
    expect(deps.pickTable).not.toHaveBeenCalled();
    deps.setConnection.mockResolvedValue(undefined);
    expect(await selectDDLTarget({ conn, table }, deps)).toBeUndefined();
    expect(deps.pickTable).not.toHaveBeenCalled();
  });

  it('stops when table selection is cancelled', async () => {
    const deps = selectionDependencies();
    deps.pickTable.mockResolvedValue(undefined);
    expect(await selectDDLTarget({}, deps)).toBeUndefined();
  });

  it('rejects non-table nodes', async () => {
    const view = { ...table };
    Object.defineProperty(view, 'type', { value: ContextValue.VIEW });
    await expect(selectDDLTarget({ conn, table: view }, selectionDependencies()))
      .rejects.toThrow('tables only');
  });
});

describe('Generate DDL presentation', () => {
  it('opens exactly one SQL document with the returned script after generation completes', async () => {
    const deps = generationDependencies();
    await generateDDL(deps);
    expect(deps.requestDDL).toHaveBeenCalledWith({ conn, table });
    expect(deps.withProgress).toHaveBeenCalledWith('Generating DDL for EMPLOYEES', expect.any(Function));
    expect(deps.openSQL).toHaveBeenCalledTimes(1);
    expect(deps.openSQL).toHaveBeenCalledWith('CREATE TABLE "APP"."EMPLOYEES" ("ID" INTEGER);');
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('does not issue a request or open an editor on cancellation', async () => {
    const deps = generationDependencies();
    deps.selectTarget.mockResolvedValue(undefined);
    await generateDDL(deps);
    expect(deps.requestDDL).not.toHaveBeenCalled();
    expect(deps.openSQL).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('treats picker dismissal as cancellation without an error notification', async () => {
    const deps = generationDependencies();
    deps.selectTarget.mockRejectedValue(new DismissedError());
    await generateDDL(deps);
    expect(deps.requestDDL).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it.each(['', ' \n '])('rejects empty output %j without opening an editor', async ddl => {
    const deps = generationDependencies();
    deps.requestDDL.mockResolvedValue(ddl);
    await generateDDL(deps);
    expect(deps.openSQL).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('Error generating table DDL', expect.any(Error));
  });

  it('reports driver failures without opening partial SQL', async () => {
    const deps = generationDependencies();
    const error = new Error('Unsupported Db2 generated column');
    deps.requestDDL.mockRejectedValue(error);
    await generateDDL(deps);
    expect(deps.openSQL).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('Error generating table DDL', error);
  });

  it('reports editor opening failures', async () => {
    const deps = generationDependencies();
    const error = new Error('Cannot open document');
    deps.openSQL.mockRejectedValue(error);
    await generateDDL(deps);
    expect(deps.onError).toHaveBeenCalledWith('Error generating table DDL', error);
  });
});
