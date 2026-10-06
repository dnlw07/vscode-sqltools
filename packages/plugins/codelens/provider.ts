import { CodeLensProvider, TextDocument, CodeLens, Range, Command, Event, EventEmitter, Selection } from 'vscode';
import * as Constants from '@sqltools/util/constants';
import { getNameFromId } from '@sqltools/util/connection';
import { extractConnName } from '@sqltools/util/query';
import { getQueryBlockConnectionName, parseQueryBlocks, stripQueryBlockMarkers } from '@sqltools/util/query/blocks';
import Context from '@sqltools/vscode/context';
import { getAttachedConnection } from '../connection-manager/attached-files';

export default class SQLToolsCodeLensProvider implements CodeLensProvider {
  private _onDidChangeCodeLenses = new EventEmitter<void>();
  get onDidChangeCodeLenses(): Event<void> {
      return this._onDidChangeCodeLenses.event;
  }

  reset() {
    this._onDidChangeCodeLenses.fire();
  }
  async provideCodeLenses(document: TextDocument): Promise<CodeLens[]> {
    const lenses: CodeLens[] = [];
    const defaultConn = extractConnName(document.getText(new Range(0, 0, 1, 0)));
    const attachedId = getAttachedConnection(document.uri);
    if (attachedId) {
      // attached to a connection
      const connName = getNameFromId(attachedId);
      const runCmd: Command = {
        arguments: [document.uri],
        title: `Detach file from ${connName.trim()}`,
        command: `${Constants.EXT_NAMESPACE}.detachConnectionFromFile`,
      };
      lenses.push(new CodeLens(new Range(0, 0, 0, 0), runCmd))
    }

    const text = document.getText();
    const allBlocks = parseQueryBlocks(text);

    if (allBlocks.length === 0) return lenses;

    allBlocks.forEach(block => {
      const start = document.positionAt(block.startOffset);
      const end = document.positionAt(block.endOffset);
      const range = new Range(start, end);
      const connName = getQueryBlockConnectionName(block, text) || defaultConn;
      const runCmd: Command = {
        arguments: [stripQueryBlockMarkers(block.text).trim(), { connNameOrId: (connName || '').trim() || undefined }],
        title: `$(debug-start) Run on ${(connName || 'active connection').trim()}`,
        command: `${Constants.EXT_NAMESPACE}.executeQuery`,
      };
      lenses.push(new CodeLens(range, runCmd));

      const selectCmd: Command = {
        arguments: [new Selection(start, end)],
        title: `$(list-selection) Select block`,
        command: `${Constants.EXT_NAMESPACE}.setSelection`,
      };
      lenses.push(new CodeLens(range, selectCmd));
    });

    return lenses;
  }

  constructor() {
    Context.subscriptions.push(this._onDidChangeCodeLenses);
  }
}
