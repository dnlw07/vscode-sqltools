"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env['PROD' + 'UCT'] = 'ls';
const server_1 = __importDefault(require("./server"));
const language_server_1 = __importDefault(require("@sqltools/plugins/formatter/language-server"));
const language_server_2 = __importDefault(require("@sqltools/plugins/connection-manager/language-server"));
const language_server_3 = __importDefault(require("@sqltools/plugins/intellisense/language-server"));
new server_1.default()
    .listen()
    .registerPlugin([
    new language_server_1.default(),
    new language_server_2.default(),
    new language_server_3.default(),
]);
//# sourceMappingURL=index.js.map