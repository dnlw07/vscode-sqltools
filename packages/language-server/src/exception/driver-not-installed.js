"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverNotInstalledError = void 0;
const response_error_1 = __importDefault(require("@sqltools/base-driver/dist/lib/exception/response-error"));
const notifications_1 = require("../notifications");
class DriverNotInstalledError extends response_error_1.default {
    constructor(driverName) {
        super(1000, `Driver ${driverName} not installed.`, {
            notification: notifications_1.DriverNotInstalledNotification,
            dontNotify: true,
            args: {
                driverName
            }
        });
    }
}
exports.DriverNotInstalledError = DriverNotInstalledError;
exports.default = DriverNotInstalledError;
//# sourceMappingURL=driver-not-installed.js.map