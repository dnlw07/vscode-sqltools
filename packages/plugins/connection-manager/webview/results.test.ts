jest.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
}), { virtual: true });
jest.mock('@sqltools/util/config-manager', () => ({
  __esModule: true, default: { results: { location: 'next' } },
}));
jest.mock('./result-group', () => ({
  ResultGroup: class {
    open = jest.fn(async create => create(2));
    track = jest.fn();
    changed = jest.fn();
    remove = jest.fn();
  },
}));
jest.mock('@sqltools/vscode/webview-provider', () => ({
  __esModule: true,
  default: class {
    public viewColumn?: number;
    public whereToShow?: number;
    public onViewColumnChanged?: () => void;
    public preserveFocus = true;
    public onDidDispose = jest.fn();
    public show() {
      if (this.viewColumn === undefined) {
        this.viewColumn = this.whereToShow;
        this.onViewColumnChanged?.();
      }
    }
  },
}));

import Config from '@sqltools/util/config-manager';
import ResultsWebviewManager from './results';
import { UIAction } from './ui/screens/Results/actions';

describe('results webview placement', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function show(location: string | number) {
    Object.assign(Config.results, { location });
    const manager = new ResultsWebviewManager();
    const view = manager.get('request');
    const pending = view.show();
    await Promise.resolve();
    await Promise.resolve();
    Reflect.get(view, 'messagesHandler')({ action: UIAction.NOTIFY_VIEW_READY, payload: true });
    jest.advanceTimersByTime(500);
    await pending;
    return view;
  }

  it.each(['next', 'beside'])('uses automatic placement for %s and preserves focus', async location => {
    const view = await show(location);
    expect(view.viewColumn).toBe(2);
    expect(view.preserveFocus).toBe(true);
    const existing = view.show();
    jest.advanceTimersByTime(500);
    await existing;
    expect(view.viewColumn).toBe(2);
  });

  it.each([['current', -1], ['end', 3], [4, 4], ['2', 2]])(
    'preserves explicit location %s', async (location, column) => {
      const view = await show(location);
      expect(view.viewColumn).toBe(column);
    });
});
