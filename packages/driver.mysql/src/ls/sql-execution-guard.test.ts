import MySQL from './driver';
import { assertSqlAllowed } from '@sqltools/util/sql-execution-policy';

describe('MySQL SQL execution guard', () => {
  it.each(['default', 'xprotocol'])('checks the complete %s script before opening', async protocol => {
    const driver = new MySQL({ id: 'test', name: 'test', driver: 'MySQL', mysqlOptions: { authProtocol: protocol } } as any, jest.fn());
    const open = jest.spyOn(driver, 'open');
    driver.setSqlExecutionGuard(sql => assertSqlAllowed(sql, ['drop\\s+table'], 'MySQL'));
    expect(() => driver.query('SELECT 1; DROP TABLE s.t', {})).toThrow('SQL execution blocked');
    expect(open).not.toHaveBeenCalled();
  });
});
