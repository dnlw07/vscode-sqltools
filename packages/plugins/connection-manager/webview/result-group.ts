import { commands, ConfigurationTarget, TabInputWebview, ViewColumn, window, workspace } from 'vscode';

interface ResultPanel {
  readonly viewColumn: ViewColumn | undefined;
}

const resultEditorId = 'mainThreadWebview-Results';
interface EditorLayout {
  orientation?: number;
  groups: { size?: number; groups?: EditorLayout['groups'] }[];
}

export class ResultGroup {
  private panels = new Map<ResultPanel, ViewColumn | undefined>();
  private preferred?: ResultPanel;
  private queue: Promise<void> = Promise.resolve();
  private placementWaiters = new Map<ResultPanel, (error?: Error) => void>();

  track(panel: ResultPanel) {
    this.panels.set(panel, panel.viewColumn);
  }

  changed(panel: ResultPanel) {
    if (panel.viewColumn !== this.panels.get(panel)) this.preferred = panel;
    this.panels.set(panel, panel.viewColumn);
    if (panel.viewColumn !== undefined) this.placementWaiters.get(panel)?.();
  }

  remove(panel: ResultPanel) {
    this.placementWaiters.get(panel)?.(new Error('SQLTools output closed before its editor group was ready.'));
    this.panels.delete(panel);
    if (this.preferred === panel) this.preferred = undefined;
  }

  private async destination(): Promise<ViewColumn> {
    const candidates = [this.preferred, ...this.panels.keys()].filter(Boolean);
    for (const panel of candidates) {
      const group = window.tabGroups.all.find(group => group.viewColumn === panel.viewColumn);
      if (group && group.tabs.length && group.tabs.every(tab =>
        tab.input instanceof TabInputWebview &&
        (tab.input.viewType === resultEditorId || tab.input.viewType === 'Results'))) {
        return group.viewColumn;
      }
    }
    const count = window.tabGroups.all.length;
    const layout = await commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    if (!layout?.groups?.length) throw new Error('Unable to read the editor layout for SQLTools outputs.');
    const next = layout.orientation === 0
      ? { orientation: 0, groups: [...layout.groups, {}] }
      : { orientation: 0, groups: [{ groups: layout.groups }, {}] };
    await commands.executeCommand('vscode.setEditorLayout', next);
    if (window.tabGroups.all.length <= count) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listener.dispose();
          reject(new Error('Unable to create the right-hand SQLTools output group.'));
        }, 5000);
        const listener = window.tabGroups.onDidChangeTabGroups(() => {
          if (window.tabGroups.all.length > count) {
            clearTimeout(timeout);
            listener.dispose();
            resolve();
          }
        });
        if (window.tabGroups.all.length > count) {
          clearTimeout(timeout);
          listener.dispose();
          resolve();
        }
      });
    }
    return window.tabGroups.all[window.tabGroups.all.length - 1].viewColumn;
  }

  open(create: (column: ViewColumn) => ResultPanel): Promise<void> {
    const pending = this.queue.then(async () => {
      const config = workspace.getConfiguration('workbench.editor');
      if (!config.get<Record<string, boolean>>('autoLockGroups', {})[resultEditorId]) {
        const existing = config.inspect<Record<string, boolean>>('autoLockGroups')?.globalValue || {};
        await config.update('autoLockGroups', { ...existing, [resultEditorId]: true }, ConfigurationTarget.Global);
        if (!config.get<Record<string, boolean>>('autoLockGroups', {})[resultEditorId]) {
          throw new Error('SQLTools output isolation requires automatic locking of Results groups. Check workspace workbench.editor.autoLockGroups overrides.');
        }
      }
      const panel = create(await this.destination());
      if (panel.viewColumn === undefined) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.placementWaiters.delete(panel);
            reject(new Error('Unable to determine the SQLTools output editor group.'));
          }, 5000);
          this.placementWaiters.set(panel, error => {
            clearTimeout(timeout);
            this.placementWaiters.delete(panel);
            if (error) reject(error);
            else resolve();
          });
        });
      }
    });
    // A failed open must reject its caller without blocking later attempts.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
