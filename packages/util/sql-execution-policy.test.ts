import { assertSqlAllowed, maskSqlNonCode, SqlExecutionPolicyError } from './sql-execution-policy';

describe('SQL execution policy', () => {
  const drop = 'drop\\s+table\\s+(?![^\\s.]*_uat\\.)[\\w]+\\.[\\w]+';

  it('blocks an entire block if executable SQL matches', () => {
    expect(() => assertSqlAllowed('-- comment\nselect 1; DROP TABLE prod.users;', [drop], 'PostgreSQL'))
      .toThrow('SQL execution blocked by pattern 1');
    expect(() => assertSqlAllowed('drop table prod_uat.users;', [drop], 'PostgreSQL')).not.toThrow();
  });

  it('ignores comments and literals without joining tokens', () => {
    expect(() => assertSqlAllowed("-- DROP TABLE prod.users\nSELECT 'drop table prod.users';", [drop], 'PostgreSQL'))
      .not.toThrow();
    expect(maskSqlNonCode('DROP/* x */TABLE', 'PostgreSQL')).toMatch(/^DROP\s+TABLE$/);
  });

  it('preserves quoted identifiers and line positions', () => {
    const sql = '/* outer\n/* inner */ end */ DROP TABLE "prod"."users";';
    const masked = maskSqlNonCode(sql, 'PostgreSQL');
    expect(masked.length).toBe(sql.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).toContain('DROP TABLE "prod"."users"');
  });

  it('does not hide executable MySQL comments', () => {
    expect(() => assertSqlAllowed('/*!50000 DROP TABLE prod.users */', [drop], 'MySQL'))
      .toThrow('SQL execution blocked');
    expect(() => assertSqlAllowed('/*M!100100 DROP TABLE prod.users */', [drop], 'MariaDB'))
      .toThrow('SQL execution blocked');
  });

  it.each([
    ['PostgreSQL', "SELECT $body$DROP TABLE prod.users$body$;"],
    ['PostgreSQL', "SELECT E'hello\\' DROP TABLE prod.users';"],
    ['Oracle', "SELECT q'[DROP TABLE prod.users]' FROM dual;"],
    ['BigQuery', 'SELECT """DROP TABLE prod.users""";'],
    ['BigQuery', '# DROP TABLE prod.users\nSELECT 1;'],
    ['MySQL', '# DROP TABLE prod.users\nSELECT 1;'],
  ])('masks strings and comments for %s', (driver, sql) => {
    expect(() => assertSqlAllowed(sql, [drop], driver)).not.toThrow();
  });

  it('validates all expressions before matching', () => {
    expect(() => assertSqlAllowed('DROP TABLE prod.users', [drop, '('], 'PostgreSQL'))
      .toThrow('Invalid SQL blocking pattern 2');
    expect(() => assertSqlAllowed('SELECT 1', ['('], 'PostgreSQL')).toThrow(SqlExecutionPolicyError);
  });

  it('allows all SQL with an empty pattern list', () => {
    expect(() => assertSqlAllowed('DROP TABLE prod.users;', [], 'PostgreSQL')).not.toThrow();
  });
});
