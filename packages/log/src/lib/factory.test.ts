import { PassThrough } from 'stream';
import factory, { formatConnectionMessage, withConnectionName } from './factory';

describe('connection-aware logging', () => {
  it('formats console messages with the same connection prefix as logs', () => {
    expect(formatConnectionMessage('Estimated bytes scanned: 10 MiB.', 'BigQuery_dev'))
      .toBe('[BigQuery_dev] Estimated bytes scanned: 10 MiB.');
    expect(formatConnectionMessage('[BigQuery_dev] Estimate', 'BigQuery_dev'))
      .toBe('[BigQuery_dev] Estimate');
    expect(formatConnectionMessage('Estimate')).toBe('Estimate');
  });

  it('prefixes messages with the active connection name', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    const logger = factory({}, stream);

    await withConnectionName('Oracle_dev', () => logger.info('log text'));

    expect(output).toContain('[Oracle_dev] log text');
  });

  it('keeps the connection name through asynchronous work', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    const logger = factory({}, stream);

    await withConnectionName('BigQuery_dev', async () => {
      await Promise.resolve();
      logger.info('log text');
    });

    expect(output).toContain('[BigQuery_dev] log text');
  });

  it('does not prefix logs when there is no active connection', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    const logger = factory({}, stream);

    await logger.info('log text');

    expect(output).toContain('log text');
    expect(output).not.toContain('[undefined]');
  });

  it('does not load Node async hooks when used from the webview logger', () => {
    const originalProduct = process.env.PRODUCT;
    const originalWindow = (global as any).window;
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      process.env.PRODUCT = 'ui';
      (global as any).window = { navigator: {} };
      jest.isolateModules(() => {
        const { default: createLogger, withConnectionName: runWithConnectionName } = require('./factory');
        const logger = createLogger();
        expect(() => runWithConnectionName('BigQuery_dev', () => logger.info('log text'))).not.toThrow();
      });
    } finally {
      log.mockRestore();
      process.env.PRODUCT = originalProduct;
      if (typeof originalWindow === 'undefined') delete (global as any).window;
      else (global as any).window = originalWindow;
    }
  });
});
