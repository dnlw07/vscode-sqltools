jest.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Beside: -2 },
  TabInputWebview: class {
    constructor(public viewType: string) {}
  },
  window: { tabGroups: { all: [] } },
  commands: { executeCommand: jest.fn() },
  workspace: { getConfiguration: jest.fn() },
}), { virtual: true });

import { commands, ConfigurationTarget, TabInputWebview, ViewColumn, window, workspace } from 'vscode';
import { ResultGroup } from './result-group';

describe('automatic result group placement', () => {
  let group: ResultGroup;
  let values: Record<string, boolean>;
  let update: jest.Mock;

  function output(column: number) {
    const panel = { viewColumn: column };
    group.track(panel);
    group.changed(panel);
    const tabs = [{ input: new TabInputWebview('mainThreadWebview-Results') }];
    Object.assign(window.tabGroups, { all: [
      { viewColumn: 1, tabs: [{ input: {} }] }, { viewColumn: column, tabs },
    ] });
    return panel;
  }

  beforeEach(() => {
    group = new ResultGroup();
    values = { terminal: true };
    Object.assign(window.tabGroups, { all: [{ viewColumn: 1, tabs: [{ input: {} }] }] });
    (commands.executeCommand as jest.Mock).mockImplementation(async command => {
      if (command === 'vscode.getEditorLayout') return {
        orientation: 0, groups: window.tabGroups.all.map(() => ({})),
      };
      Object.assign(window.tabGroups, { all: [...window.tabGroups.all, {
        viewColumn: window.tabGroups.all.length + 1, tabs: [],
      }] });
    });
    update = jest.fn(async (_name, next) => { values = next; });
    (workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: () => values,
      inspect: () => ({ globalValue: values }),
      update,
    });
  });

  it('configures only Results auto-locking and opens the first output to the right of files', async () => {
    const create = jest.fn(column => { expect(column).toBe(2); return output(2); });
    await group.open(create);
    expect(update).toHaveBeenCalledWith('autoLockGroups', {
      terminal: true, 'mainThreadWebview-Results': true,
    }, ConfigurationTarget.Global);
    expect(workspace.getConfiguration).toHaveBeenCalledWith('workbench.editor');
  });

  it('reuses live outputs regardless of active text editor or output focus', async () => {
    output(2);
    const create = jest.fn((_column: ViewColumn) => output(2));
    await group.open(create);
    await group.open(create);
    expect(create.mock.calls.map(call => call[0])).toEqual([2, 2]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('waits for actual placement before opening the next parallel output', async () => {
    const panel: { viewColumn: ViewColumn | undefined } = { viewColumn: undefined };
    group.track(panel);
    const first = group.open(() => panel);
    const create = jest.fn(() => output(2));
    const second = group.open(create);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    Object.assign(window.tabGroups, { all: [{
      viewColumn: 2, tabs: [{ input: new TabInputWebview('mainThreadWebview-Results') }],
    }] });
    panel.viewColumn = 2;
    group.changed(panel);
    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledWith(2);
  });

  it('follows output movement and current group numbering', async () => {
    const panel = output(2);
    panel.viewColumn = 3;
    Object.assign(window.tabGroups, { all: [{
      viewColumn: 3, tabs: [{ input: new TabInputWebview('mainThreadWebview-Results') }],
    }] });
    group.changed(panel);
    const create = jest.fn(() => output(3));
    await group.open(create);
    expect(create).toHaveBeenCalledWith(3);
  });

  it('does not reuse a group containing source files', async () => {
    output(2);
    Object.assign(window.tabGroups, { all: [
      { viewColumn: 1, tabs: [{ input: {} }] }, { viewColumn: 2, tabs: [{ input: {} }] },
    ] });
    const create = jest.fn(() => output(3));
    await group.open(create);
    expect(create).toHaveBeenCalledWith(3);
  });

  it('falls back to another live output, then resets after all outputs close', async () => {
    const first = output(2);
    const second = output(2);
    group.remove(second);
    const create = jest.fn(() => ({ viewColumn: 2 }));
    await group.open(create);
    expect(create).toHaveBeenLastCalledWith(2);
    group.remove(first);
    await group.open(create);
    expect(create).toHaveBeenLastCalledWith(3);
  });

  it('leaves an already enabled rule untouched', async () => {
    values['mainThreadWebview-Results'] = true;
    await group.open(() => output(2));
    expect(update).not.toHaveBeenCalled();
  });

  it('reports configuration failure and allows the next open to retry', async () => {
    update.mockRejectedValueOnce(new Error('Settings are read-only'));
    await expect(group.open(() => output(2))).rejects.toThrow('Settings are read-only');
    await group.open(() => output(2));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('reports workspace overrides rather than claiming output isolation succeeded', async () => {
    update.mockImplementation(async () => undefined);
    const create = jest.fn(() => output(2));
    await expect(group.open(create)).rejects.toThrow('workspace');
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves a vertical file layout inside the left side without moving existing tabs', async () => {
    (commands.executeCommand as jest.Mock).mockImplementation(async command => {
      if (command === 'vscode.getEditorLayout') return {
        orientation: 1, groups: [{ size: 0.4 }, { size: 0.6 }],
      };
      Object.assign(window.tabGroups, { all: [
        { viewColumn: 1, tabs: [] }, { viewColumn: 2, tabs: [] }, { viewColumn: 3, tabs: [] },
      ] });
    });
    await group.open(() => ({ viewColumn: 3 }));
    expect(commands.executeCommand).toHaveBeenCalledWith('vscode.setEditorLayout', {
      orientation: 0, groups: [{ groups: [{ size: 0.4 }, { size: 0.6 }] }, {}],
    });
  });

  it('rejects an output closed before placement and keeps later opens usable', async () => {
    const panel: { viewColumn: ViewColumn | undefined } = { viewColumn: undefined };
    group.track(panel);
    const pending = group.open(() => panel);
    const failure = expect(pending).rejects.toThrow('closed');
    await new Promise(resolve => setTimeout(resolve, 0));
    group.remove(panel);
    await failure;
    await group.open(() => output(2));
  });
});
