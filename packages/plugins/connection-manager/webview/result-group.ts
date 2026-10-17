import { commands, ConfigurationTarget, TabInputWebview, ViewColumn, window, workspace } from 'vscode';
import { createLogger } from '@sqltools/log/src';

const log = createLogger('results-layout');

interface ResultPanel {
  readonly viewColumn: ViewColumn | undefined;
}

const resultEditorId = 'mainThreadWebview-Results';
interface EditorLayout {
  orientation?: number;
  groups: { size?: number; groups?: EditorLayout['groups'] }[];
}

export type ResultPosition = 'right' | 'bottom';

const bottomShare = 1 / 4;
const bottomTolerance = 0.02;

function rightLayout(layout: EditorLayout): EditorLayout {
  return layout.orientation === 0
    ? { orientation: 0, groups: [...layout.groups, {}] }
    : { orientation: 0, groups: [{ groups: layout.groups }, {}] };
}

// Sizes are proportions of the editor area, so the results group takes bottomShare of the height.
function bottomLayout(layout: EditorLayout): EditorLayout {
  if (layout.orientation === 1) {
    const count = layout.groups.length;
    return {
      orientation: 1,
      groups: [
        ...layout.groups.map(group => ({ ...group, size: (group.size ?? 1 / count) * (1 - bottomShare) })),
        { size: bottomShare },
      ],
    };
  }
  // A lone editor group is split directly; wrapping it in a nested single-child branch is avoided.
  const top = layout.groups.length === 1 && !layout.groups[0].groups
    ? { size: 1 - bottomShare }
    : { groups: layout.groups, size: 1 - bottomShare };
  return { orientation: 1, groups: [top, { size: bottomShare }] };
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

  private async destination(position: ResultPosition): Promise<ViewColumn> {
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
    const next = position === 'bottom' ? bottomLayout(layout) : rightLayout(layout);
    await commands.executeCommand('vscode.setEditorLayout', next);
    if (window.tabGroups.all.length <= count) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listener.dispose();
          reject(new Error(`Unable to create the ${position} SQLTools output group.`));
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

  // Layout sizes are proportions; a results group that grew past its share (e.g. after a layout
  // rebuild) is shrunk back, while a smaller group the user resized is left alone.
  private async limitBottomSize(column: ViewColumn | undefined, force = false, stage = 'check') {
    const groups = window.tabGroups.all;
    const last = groups[groups.length - 1];
    if (!last || last.viewColumn !== column || groups.length < 2) {
      log.info(`[${stage}] skipped: column=${column} groups=${groups.length} lastColumn=${last?.viewColumn}`);
      return;
    }
    const layout = await commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    log.info(`[${stage}] force=${force} groups=${groups.length} layout=${JSON.stringify(layout)}`);
    if (!layout || layout.orientation !== 1 || layout.groups.length < 2) return;
    const count = layout.groups.length;
    const sizes = layout.groups.map(group => group.size ?? 1 / count);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const bottom = sizes[count - 1] / total;
    if (!force && bottom <= bottomShare + bottomTolerance) return;
    const others = total - sizes[count - 1];
    if (others <= 0) return;
    log.info(`[${stage}] resizing bottom from ${bottom.toFixed(3)} to ${bottomShare}`);
    // Sizes are scaled to the current pixel total; tiny fractions are clamped to the minimum group size on a fresh group.
    await commands.executeCommand('vscode.setEditorLayout', {
      orientation: 1,
      groups: layout.groups.map((group, index) => ({
        ...group,
        size: (index === count - 1 ? bottomShare : (sizes[index] / others) * (1 - bottomShare)) * total,
      })),
    });
  }

  open(create: (column: ViewColumn) => ResultPanel, position: ResultPosition = 'right'): Promise<void> {
    const pending = this.queue.then(async () => {
      const config = workspace.getConfiguration('workbench.editor');
      if (!config.get<Record<string, boolean>>('autoLockGroups', {})[resultEditorId]) {
        const existing = config.inspect<Record<string, boolean>>('autoLockGroups')?.globalValue || {};
        await config.update('autoLockGroups', { ...existing, [resultEditorId]: true }, ConfigurationTarget.Global);
        if (!config.get<Record<string, boolean>>('autoLockGroups', {})[resultEditorId]) {
          throw new Error('SQLTools output isolation requires automatic locking of Results groups. Check workspace workbench.editor.autoLockGroups overrides.');
        }
      }
      const before = window.tabGroups.all.length;
      const column = await this.destination(position);
      const created = window.tabGroups.all.length > before;
      // Enforce the size before the webview is attached so the editor area is never covered, even briefly.
      if (position === 'bottom') await this.limitBottomSize(column, created, `before-attach created=${created}`).catch(() => undefined);
      const panel = create(column);
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
      if (position === 'bottom') {
        // A freshly created group reports proportions that look right while the rendered layout is not, so it is re-applied.
        await this.limitBottomSize(panel.viewColumn, created, 'after-attach').catch(() => undefined);
        // VS Code can still reflow the grid while the new webview is being attached, so re-check shortly after.
        for (const delay of [50, 200, 600, 1500]) {
          const timer = setTimeout(() => this.limitBottomSize(panel.viewColumn, created, `+${delay}ms`).catch(() => undefined), delay);
          (timer as any).unref?.();
        }
      }
    });
    // A failed open must reject its caller without blocking later attempts.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
