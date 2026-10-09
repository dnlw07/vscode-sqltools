import { ContextValue, IConnection, NSDatabase } from '@sqltools/types';
import { DismissedError } from '@sqltools/util/exception';

export interface DDLTarget {
  conn: IConnection;
  table: NSDatabase.ITable;
}

export interface DDLSelection {
  conn?: IConnection;
  table?: NSDatabase.ITable;
}

interface SelectionDependencies {
  connect: () => Promise<IConnection | undefined>;
  setConnection: (conn: IConnection) => Promise<IConnection | undefined>;
  pickTable: (conn: IConnection) => Promise<NSDatabase.ITable | undefined>;
}

export async function selectDDLTarget(
  selection: DDLSelection,
  deps: SelectionDependencies
): Promise<DDLTarget | undefined> {
  const conn = selection.conn ? await deps.setConnection(selection.conn) : await deps.connect();
  if (!conn) return;
  const table = selection.table || await deps.pickTable(conn);
  if (!table) return;
  if (table.type !== ContextValue.TABLE) throw new Error('Generate DDL supports tables only.');
  return { conn, table };
}

interface GenerationDependencies {
  selectTarget: () => Promise<DDLTarget | undefined>;
  requestDDL: (target: DDLTarget) => Promise<string>;
  withProgress: (title: string, generate: () => Promise<string>) => Promise<string>;
  openSQL: (content: string) => Promise<void>;
  onError: (message: string, error: Error) => void;
}

export async function generateDDL(deps: GenerationDependencies): Promise<void> {
  try {
    const target = await deps.selectTarget();
    if (!target) return;
    const ddl = await deps.withProgress(`Generating DDL for ${target.table.label}`, () => deps.requestDDL(target));
    if (typeof ddl !== 'string' || !ddl.trim()) throw new Error('The driver returned no table DDL.');
    await deps.openSQL(ddl);
  } catch (error) {
    if (error instanceof DismissedError) return;
    deps.onError('Error generating table DDL', error);
  }
}
