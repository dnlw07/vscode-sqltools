import SQLite from './driver';
import { assertSqlAllowed } from '@sqltools/util/sql-execution-policy';

describe('SQLite SQL execution guard', () => {
  it('checks a complete script before opening or executing it', async () => {
    const driver = new SQLite({ id: 'test', name: 'test', driver: 'SQLite' } as any, jest.fn());
    const open = jest.spyOn(driver, 'open');
    driver.setSqlExecutionGuard(sql => assertSqlAllowed(sql, ['drop\\s+table'], 'SQLite'));
    await expect(driver.query('SELECT 1; DROP TABLE users', {})).rejects.toThrow('SQL execution blocked');
    expect(open).not.toHaveBeenCalled();
  });

  it('checks internally generated statements before calling SQLite', async () => {
    const driver = new SQLite({ id: 'test', name: 'test', driver: 'SQLite' } as any, jest.fn());
    driver.setSqlExecutionGuard(sql => assertSqlAllowed(sql, ['select'], 'SQLite'));
    const db = { all: jest.fn() };
    expect(() => (driver as any).runSingleQuery(db, 'SELECT 1')).toThrow('SQL execution blocked');
    expect(db.all).not.toHaveBeenCalled();
  });
});
