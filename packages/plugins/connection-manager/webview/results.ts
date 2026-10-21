import { NSDatabase, InternalID } from '@sqltools/types';
import WebviewProvider from '@sqltools/vscode/webview-provider';
import { ResultsScreenState } from './ui/screens/Results/interfaces';
import vscode from 'vscode';
import Config from '@sqltools/util/config-manager';
import { getNameFromId } from '@sqltools/util/connection';
import { DISPLAY_NAME } from '@sqltools/util/constants';
import { UIAction } from './ui/screens/Results/actions';
import { ResultGroup } from './result-group';
import generateId from '@sqltools/util/internal-id';

class ResultsWebview extends WebviewProvider<ResultsScreenState> {
  protected id: string = 'Results';
  protected title: string = `${DISPLAY_NAME} Results`;
  protected isOpen = false;
  private readinessWaiters = new Set<(error?: Error) => void>();

  constructor(public requestId: string, private group: ResultGroup) {
    super();

    this.onDidDispose(() => {
      this.isOpen = false;
      this.resolveReadiness(new Error('SQLTools results webview was closed before it became ready.'));
    });
  }

  private resolveReadiness(error?: Error) {
    const waiters = [...this.readinessWaiters];
    this.readinessWaiters.clear();
    waiters.forEach(resolve => resolve(error));
  }

  protected messagesHandler = ({ action, payload }) => {
    switch (action) {
      case UIAction.NOTIFY_VIEW_READY:
        this.isOpen = payload;
        if (this.isOpen) this.resolveReadiness();
        return;
    }
  };

  public get cssVariables() {
    if (!Config.results.customization) {
      return {};
    }
    return Config.results.customization;
  }

  async show() {
    const location = String(Config.results.location || 'next');
    const automatic = !location || ['next', 'beside', 'right', 'bottom'].includes(location);
    if (this.viewColumn === undefined && automatic) {
      await this.group.open(column => {
        this.whereToShow = column;
        super.show();
        return this;
      }, location === 'bottom' ? 'bottom' : 'right');
    } else {
      if (this.viewColumn === undefined) {
        this.whereToShow = undefined;
        switch (location) {
          case 'none':
            break;
          case 'active': // fallback older version
          case 'current':
            this.whereToShow = vscode.ViewColumn.Active;
            break;
          case 'end':
            this.whereToShow = vscode.ViewColumn.Three;
            break;
          default:
            this.whereToShow = Number(location) as vscode.ViewColumn;
            break;
        }
      }
      super.show();
    }

    if (this.isOpen) return;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.readinessWaiters.delete(finish);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error(
          'SQLTools results webview did not become ready within 15 seconds. Check the Webview Developer Tools Console for startup errors.'
        ));
      }, 15000);
      this.readinessWaiters.add(finish);
      if (this.isOpen) finish();
    });
  }

  updateResults = (payload: NSDatabase.IResult[]) => {
    this.title = `${DISPLAY_NAME} Console`;
    try {
      const prefix = getNameFromId(payload[0].connId);
      let suffix: string;
      if (payload && payload.length > 0) {
        payload.forEach((result, index) => {
          if (!result.label) {
            const matches = [...result.query.matchAll(/^--\s*@label\s*(.+)$/gm)];
            if (index > 0 || payload.length === 1 || !matches[1]) {
              result.label = matches[0] ? matches[0][1].trim() : undefined;
            } else {
              // If two @label comments precede the first statement of a multi-statement block, note the first for use as the top label
              // and use the second as the statement's label
              suffix = matches[0][1].trim() || undefined;
              result.label = matches[1][1].trim() || undefined;
            }
          }
        });
        if (payload.length === 1) {
          let truncatedQuery = payload[0].query.length > 16 ? `${payload[0].query.substring(0, 16)}...` : payload[0].query;
          suffix = payload[0].label ? payload[0].label : truncatedQuery.replace(/(\r?\n\s*)/gim, ' ');
        } else {
          suffix = suffix || 'multiple query results';
        }
      }
      this.title = `${prefix}: ${suffix}`;
    } catch (error) { }
    this.updatePanelName();
    this.sendMessage(UIAction.RESPONSE_RESULTS, { resultTabs: payload, showConsole: Config.results.showConsoleOnError  && payload.some(p => !!p.error) });
  }

  whereToShow = vscode.ViewColumn.Active;
}

export default class ResultsWebviewManager {
  private viewsMap: { [id: string]: ResultsWebview } = {};
  private group = new ResultGroup();

  dispose = () => {
    return Promise.all(Object.keys(this.viewsMap).map(id => this.viewsMap[id].dispose()));
  }

  private createForId = (requestId: InternalID) => {
    const view = new ResultsWebview(requestId, this.group);
    this.viewsMap[requestId] = view;
    this.group.track(view);
    view.onViewColumnChanged = () => this.group.changed(view);
    view.onDidDispose(() => {
      this.group.remove(view);
      delete this.viewsMap[requestId];
    });
    return this.viewsMap[requestId];
  }

  get = (requestId: InternalID) => {
    if (!requestId) throw new Error('Missing request id to create results view');

    return this.viewsMap[requestId] || this.createForId(requestId);
  }

  public getActiveView = () => {
    return this.viewsMap[Object.keys(this.viewsMap).find(k => this.viewsMap[k] && this.viewsMap[k].isActive)];
  }

  // Per-connection reuse: a pinned tab is never overwritten; its results are kept and a new tab is used instead.
  public getReusableId = (connId: string): string => {
    const ids = Object.keys(this.viewsMap).filter(id => id === connId || id.startsWith(`${connId}#`));
    if (!ids.length) return connId;
    const free = ids.reverse().find(id => !this.viewsMap[id].isPinned);
    return free || `${connId}#${generateId()}`;
  }
}
