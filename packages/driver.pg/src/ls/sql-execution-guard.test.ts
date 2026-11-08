import PostgreSQL from './driver';
import { assertSqlAllowed } from '@sqltools/util/sql-execution-policy';

describe('PostgreSQL SQL execution guard', () => {
  const credentials = { id: 'test', name: 'test', driver: 'PostgreSQL' } as any;
  const guard = (sql: string) => assertSqlAllowed(sql, ['drop\\s+table|update'], 'PostgreSQL');

  it('preflights the whole script before opening', () => {
    const driver = new PostgreSQL(credentials, jest.fn());
    const open = jest.spyOn(driver, 'open');
    driver.setSqlExecutionGuard(guard);
    expect(() => driver.query('SELECT 1; DROP TABLE s.t', {})).toThrow('SQL execution blocked');
    expect(open).not.toHaveBeenCalled();
  });

  it('guards client queries and SQL objects', () => {
    const driver = new PostgreSQL(credentials, jest.fn());
    const query = jest.fn();
    const client = (driver as any).guardClient({ query });
    driver.setSqlExecutionGuard(guard);
    expect(() => client.query({ text: 'UPDATE t SET x = 1' })).toThrow('SQL execution blocked');
    expect(query).not.toHaveBeenCalled();
  });

  it('preflights grid updates before starting a transaction', async () => {
    const driver = new PostgreSQL(credentials, jest.fn());
    const query = jest.fn();
    jest.spyOn(driver, 'open').mockResolvedValue({ connect: async () => ({ query, release: jest.fn() }) } as any);
    driver.setSqlExecutionGuard(guard);
    const result = await driver.applyEdits([{
      table: { schema: 'S', label: 'T' }, primaryKey: { ID: 1 }, changes: { NAME: 'x' },
    } as any], {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('SQL execution blocked');
    expect(query).not.toHaveBeenCalled();
  });
});
