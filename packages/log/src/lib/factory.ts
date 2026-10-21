import pino, { LoggerOptions, DestinationStream, Logger } from 'pino';
import type { AsyncLocalStorage as AsyncLocalStorageType } from 'async_hooks';

declare var window: any;
declare const __non_webpack_require__: NodeRequire;

const connectionLogContextKey = Symbol.for('sqltools.connectionLogContext');
let connectionLogContext: AsyncLocalStorageType<string> | undefined;

function getConnectionLogContext(): AsyncLocalStorageType<string> | undefined {
  // `global` does not exist in the browser-based webviews, so it must never be touched at module load.
  if (typeof window !== 'undefined' && window.navigator && process.env.PRODUCT === 'ui') return undefined;
  if (connectionLogContext) return connectionLogContext;
  const runtimeGlobal = globalThis as any;
  if (runtimeGlobal[connectionLogContextKey]) {
    connectionLogContext = runtimeGlobal[connectionLogContextKey];
    return connectionLogContext;
  }

  const loadNativeModule = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : require;
  const AsyncLocalStorage = loadNativeModule('async_hooks').AsyncLocalStorage as typeof AsyncLocalStorageType;
  connectionLogContext = new AsyncLocalStorage<string>();
  runtimeGlobal[connectionLogContextKey] = connectionLogContext;
  return connectionLogContext;
}

export function withConnectionName<T>(name: string | undefined, callback: () => T): T {
  const context = getConnectionLogContext();
  if (!name || !context) return callback();
  let result!: T;
  context.run(name, () => { result = callback(); });
  return result;
}

export function formatConnectionMessage(message: string, name?: string): string {
  if (!name) return message;
  const prefix = `[${name}]`;
  return message.startsWith(prefix) ? message : `${prefix} ${message}`;
}

function factory(opts: LoggerOptions = {}, stream?: DestinationStream) {
  if (typeof window !=='undefined' && window.navigator && process.env.PRODUCT === 'ui') {
    const interpolate = (args: IArguments) => {
      const newArgs = args[0].toString().split(/\s*\%[a-z]\s*/i);
      return newArgs.reduce((a, p, i) => {
        if (typeof p !== 'undefined') {
          a.push(p)
        }
        if (typeof args[i + 1] !== 'undefined') {
          a.push(args[i + 1])
        }
        return a;
      }, []);
    }

    const logger =  new Proxy({}, {
      get(_: never, prop: string) {
        if (prop === 'child') return () => logger;
        return function() {(console[prop] || console.log).call(null, prop.toUpperCase(), ...interpolate(arguments));}
      },
      set() { throw new Error('SET')},
    }) as Logger & { show: () => void; outputChannel?: { show: () => void } };
    return logger;
  };
  const logMethod: NonNullable<LoggerOptions['hooks']>['logMethod'] = function(args, method) {
    const connectionName = getConnectionLogContext()?.getStore();
    if (!connectionName) return method.apply(this, args);

    const messageIndex = typeof args[0] === 'string' ? 0 : typeof args[1] === 'string' ? 1 : -1;
    const logArgs = args.slice();
    if (messageIndex >= 0) {
      logArgs[messageIndex] = formatConnectionMessage(logArgs[messageIndex], connectionName);
    } else if (logArgs[0] instanceof Error) {
      logArgs[0] = { err: logArgs[0], msg: formatConnectionMessage('', connectionName).replace(/\s+$/, '') };
    } else if (logArgs[0] && typeof logArgs[0] === 'object' && !Array.isArray(logArgs[0])) {
      const fields = logArgs[0];
      logArgs[0] = {
        ...fields,
        msg: formatConnectionMessage(typeof fields.msg === 'string' ? fields.msg : '', connectionName),
      };
    } else {
      logArgs.unshift(formatConnectionMessage('', connectionName).replace(/\s+$/, ''));
    }
    return method.apply(this, logArgs);
  };
  const logger = pino({
    name: process.env.PRODUCT || 'UNINDENTIFIED',
    base: {},
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    formatters: {
      level(level) { return { level }; },
    },
    prettyPrint: true,
    ...opts,
    hooks: {
      ...opts.hooks,
      logMethod,
    },
  }, stream);

  logger.show = () => void 0;

  return logger as Logger & { show: () => void; outputChannel?: { show: () => void } };
}

export default factory;
