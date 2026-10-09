"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const exception_1 = require("@sqltools/util/exception");
const src_1 = require("@sqltools/log/src");
const log = (0, src_1.createLogger)('ls-context');
const Context = new Map();
class DriverMap extends Map {
    set(key, value) {
        if (typeof key !== 'string')
            throw 'invalid driver name!';
        key = key.toLowerCase();
        log.info({ place: 'driver-map' }, 'Driver %s registered!', key);
        return super.set(key, value);
    }
    get(key) { return super.get(key.toLowerCase()); }
    has(key) { return super.has(key.toLowerCase()); }
    delete(key) { return super.delete(key.toLowerCase()); }
}
const DriversContext = new DriverMap();
const handler = {
    get(_, prop) {
        if (prop === 'clear'
            || prop === 'delete') {
            throw new exception_1.InvalidActionError(`Cannot ${prop} on LSContext!`);
        }
        if (prop === 'drivers')
            return DriversContext;
        return Context[prop];
    },
    set() {
        throw new exception_1.InvalidActionError('Cannot set values to extension context directly!');
    },
};
const LSContext = new Proxy(Context, handler);
exports.default = LSContext;
//# sourceMappingURL=context.js.map