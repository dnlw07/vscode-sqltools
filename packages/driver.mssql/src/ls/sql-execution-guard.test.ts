import MSSQL from './driver';
import { assertSqlAllowed } from '@sqltools/util/sql-execution-policy';

it('checks SQL Server scripts before opening the connection', async () => {
  const driver = new MSSQL({ id: 'test', name: 'test', driver: 'MSSQL' } as any, jest.fn());
  const open = jest.spyOn(driver, 'open');
  driver.setSqlExecutionGuard(sql => assertSqlAllowed(sql, ['drop\\s+table'], 'MSSQL'));
  await expect(driver.query('SELECT 1; DROP TABLE s.t', {})).rejects.toThrow('SQL execution blocked');
  expect(open).not.toHaveBeenCalled();
});
