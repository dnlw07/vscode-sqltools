"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_manager_1 = __importDefault(require("@sqltools/util/config-manager"));
const vscode_languageserver_1 = require("vscode-languageserver");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const exception_1 = require("@sqltools/util/exception");
const constants_1 = require("@sqltools/util/constants");
const contracts_1 = require("./contracts");
const context_1 = __importDefault(require("./context"));
const notifications_1 = require("./notifications");
const path_1 = require("path");
const child_process_1 = require("child_process");
const src_1 = require("@sqltools/log/src");
const log = (0, src_1.createLogger)();
class SQLToolsLanguageServer {
    _server;
    _docManager = new vscode_languageserver_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
    onInitializeHooks = [];
    onInitializedHooks = [];
    onDidChangeConfigurationHooks = [];
    constructor() {
        this._server = (0, vscode_languageserver_1.createConnection)(vscode_languageserver_1.ProposedFeatures.all);
        this._server.onInitialized(this.onInitialized);
        this._server.onInitialize(this.onInitialize);
        this._server.onDidChangeConfiguration(this.onDidChangeConfiguration);
        this._docManager.listen(this._server);
        this.setAutoStart();
        this.onRequest(contracts_1.RegisterPlugin, this.onRegisterPlugin);
    }
    setAutoStart() {
        const nodeExit = process.exit;
        process.exit = ((code) => {
            const stack = new Error('stack');
            this.sendNotification(notifications_1.ExitCalledNotification, [code ? code : 0, stack.stack]);
            setTimeout(() => nodeExit(code), 500);
        });
        process.on('uncaughtException', (error) => {
            let message;
            if (error) {
                if (typeof error.stack === 'string') {
                    message = error.stack;
                }
                else if (typeof error.message === 'string') {
                    message = error.message;
                }
                else if (typeof error === 'string') {
                    message = error;
                }
                else {
                    message = (error || '').toString();
                }
            }
            if (message) {
                log.error(message);
            }
        });
    }
    onRegisterPlugin = async ({ path: pluginPath } = { path: '' }) => {
        log.info('request to register plugin: "%s"', pluginPath);
        try {
            let plugin = (__non_webpack_require__ || require)((0, path_1.resolve)(pluginPath));
            plugin = plugin.default || plugin;
            await this.registerPlugin(plugin);
            log.debug('plugin %s loaded', pluginPath);
        }
        catch (error) {
            log.error({ error }, 'Error registering plugin: %O', error);
            return Promise.reject(error);
        }
    };
    getContext = () => {
        return context_1.default;
    };
    onInitialized = (params) => {
        log.info(`Initialized with node version:${process.version}`);
        this.onInitializedHooks.forEach(hook => hook(params));
    };
    onInitialize = (params, token, workDoneProgress, resultProgress) => {
        if (params.initializationOptions.userEnvVars && Object.keys(params.initializationOptions.userEnvVars || {}).length > 0) {
            log.info(`User defined env vars\n===============================\n%O\n===============================:`, params.initializationOptions.userEnvVars);
        }
        return this.onInitializeHooks.reduce((opts, hook) => {
            const result = hook(params, token, workDoneProgress, resultProgress);
            return { ...result, capabilities: { ...opts.capabilities, ...result.capabilities } };
        }, {
            capabilities: {
                documentFormattingProvider: true,
                documentRangeFormattingProvider: true,
                textDocumentSync: vscode_languageserver_1.TextDocumentSyncKind.Incremental,
                workspace: {
                    workspaceFolders: {
                        supported: true,
                        changeNotifications: true
                    },
                }
            },
        });
    };
    onDidChangeConfiguration = changes => {
        config_manager_1.default.replaceAll(changes.settings[constants_1.EXT_CONFIG_NAMESPACE]);
        this.onDidChangeConfigurationHooks.forEach(hook => hook());
    };
    get onDocumentFormatting() {
        return this._server.onDocumentFormatting;
    }
    get onDocumentRangeFormatting() {
        return this._server.onDocumentRangeFormatting;
    }
    get onCompletion() {
        return this._server.onCompletion;
    }
    get onCompletionResolve() {
        return this._server.onCompletionResolve;
    }
    listen() {
        const isNode = parseInt(process.env.IS_NODE_RUNTIME || '0') === 1;
        let version = '';
        try {
            if (isNode) {
                const { output } = (0, child_process_1.spawnSync)(process.execPath, ['-v']);
                version = output.join('');
            }
        }
        catch (error) { }
        log.info([
            `${constants_1.DISPLAY_NAME} Server started!`,
            '===============================',
            `Using node runtime?: ${isNode ? 'yes' : 'no'}`,
            `ExecPath: ${process.execPath} ${version.replace(/[\r\n]/g, '').trim()}`,
            '==============================='
        ].filter(Boolean).join('\n'));
        this._server.listen();
        return this;
    }
    async registerPlugin(plugin) {
        await Promise.all((Array.isArray(plugin) ? plugin : [plugin].filter(Boolean))
            .map(p => p.register(this)));
    }
    get sendNotification() {
        return this._server.sendNotification;
    }
    get onNotification() {
        return this._server.onNotification;
    }
    onRequest = (req, handler) => {
        if (!handler)
            throw new exception_1.InvalidActionError('Disabled registration for * handlers');
        return this._server.onRequest(req, async (...args) => {
            process.env.NODE_ENV === 'development' && log.info('REQUEST RECEIVED => %s %o', req._method || req.toString(), args);
            process.env.NODE_ENV !== 'development' && log.info('REQUEST RECEIVED => %s', req._method || req.toString());
            return Promise.resolve(handler(...args));
        });
    };
    get sendRequest() {
        return this._server.sendRequest;
    }
    addOnDidChangeConfigurationHooks(hook) {
        this.onDidChangeConfigurationHooks.push(hook);
        return this;
    }
    addOnInitializeHook(hook) {
        this.onInitializeHooks.push(hook);
        return this;
    }
    addOnInitializedHook(hook) {
        this.onInitializedHooks.push(hook);
        return this;
    }
    get server() {
        return this._server;
    }
    get client() {
        return this._server.client;
    }
    get docManager() {
        return this._docManager;
    }
    notifyError(message, error) {
        const cb = (err = '') => {
            log.error(err, { message, languageServer: true });
            this._server.sendNotification(notifications_1.ServerErrorNotification, { err, message, errMessage: (err.message || err).toString() });
        };
        if (typeof error !== 'undefined')
            return cb(error);
        return cb;
    }
}
exports.default = SQLToolsLanguageServer;
//# sourceMappingURL=server.js.map