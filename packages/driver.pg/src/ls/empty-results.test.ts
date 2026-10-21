jest.mock('./aws-iam', () => ({
  signAwsIamToken: jest.fn(),
  validateIamAuthOptions: jest.fn(),
}));

const mockConnect = jest.fn();
jest.mock('pg', () => ({
  Pool: class {
    connect = mockConnect;
  },
  types: {
    setTypeParser: jest.fn(),
    builtins: { TIMESTAMP: 1114, TIMESTAMPTZ: 1184, DATE: 1082 },
  },
}));

import PostgreSQL from './driver';

describe('PostgreSQL empty query results', () => {
  const fields = [{ name: 'employee_id' }, { name: 'DisplayName' }];

  function setup(rows: unknown[][] = []) {
    const driver = new PostgreSQL({
      id: 'empty-results', name: 'test', driver: 'PostgreSQL',
      username: 'test', isConnected: false, isActive: false,
    }, async () => []);
    const client = {
      on: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async () => ({ rows, fields, command: 'SELECT', rowCount: rows.length })),
    };
    mockConnect.mockResolvedValue(client);
    return driver;
  }

  for (const internal of [false, true]) {
    it(`retains headers for an empty ${internal ? 'regular' : 'paginated'} SELECT`, async () => {
      const options = { requestId: 'request', __internal: internal };
      const [result] = await setup().query('SELECT * FROM employees', options);
      expect(result.error).not.toBe(true);
      expect(result.cols).toEqual(['employee_id', 'DisplayName']);
      expect(result.results).toEqual([]);
    });
  }

  it('hides trigger NEW/EXISTING JSON notices but keeps other notices', async () => {
    const driver = setup();
    const client: any = await mockConnect();
    const notices: Record<string, (notice: any) => void> = {};
    client.on.mockImplementation((event: string, handler: any) => { notices[event] = handler; });
    client.query.mockImplementation(async () => {
      notices.notice({ name: 'notice', message: 'NEW JSON {"a": 1}' });
      notices.notice({ name: 'notice', message: 'EXISTING JSON {"a": null}' });
      notices.notice({ name: 'notice', message: 'NEW JSON' });
      notices.notice({ name: 'notice', message: 'something else' });
      return { rows: [], fields: [], command: 'UPDATE', rowCount: 1 };
    });

    const [result] = await driver.query('UPDATE t SET a = 1', { __internal: true } as any);

    const messages = result.messages.map((m: any) => m.message);
    expect(messages.some((m: string) => /JSON/.test(m))).toBe(false);
    expect(messages).toContain('NOTICE: something else');
    expect(messages.length).toBeGreaterThan(1);
  });

  it('retains populated result mapping', async () => {
    const options = { __internal: true };
    const [result] = await setup([[1, 'Test']]).query('SELECT * FROM employees', options);
    expect(result.cols).toEqual(['employee_id', 'DisplayName']);
    expect(result.results).toEqual([{ employee_id: 1, DisplayName: 'Test' }]);
  });
});
