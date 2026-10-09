import { window } from 'vscode';
import { DismissedError } from '@sqltools/util/exception';
import { quickPick, quickPickSearch } from './quickPick';

jest.mock('vscode', () => ({ window: { createQuickPick: jest.fn() } }), { virtual: true });
jest.mock('@sqltools/log/src', () => ({ createLogger: () => ({ error: jest.fn() }) }));

function createPicker() {
  let hide: () => void;
  let select: (items: { label: string; value?: unknown }[]) => void;
  const picker = {
    onDidHide: jest.fn(callback => { hide = callback; }),
    onDidChangeSelection: jest.fn(callback => { select = callback; }),
    onDidTriggerButton: jest.fn(),
    onDidChangeValue: jest.fn(),
    hide: jest.fn(() => hide()),
    dispose: jest.fn(),
    show: jest.fn(),
    accept: (items: { label: string; value?: unknown }[]) => select(items),
  };
  (window.createQuickPick as jest.Mock).mockReturnValue(picker);
  return picker;
}

describe('picker dismissal used by Generate DDL', () => {
  it('settles connection picker cancellation instead of leaving the command pending', async () => {
    const picker = createPicker();
    const selection = quickPick([{ label: 'Db2', value: 'db2' }], 'value');
    picker.hide();
    await expect(selection).rejects.toBeInstanceOf(DismissedError);
    expect(picker.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains an accepted connection even though hide fires synchronously', async () => {
    const picker = createPicker();
    const selection = quickPick([{ label: 'Db2', value: 'db2' }], 'value');
    picker.accept([{ label: 'Db2', value: 'db2' }]);
    await expect(selection).resolves.toBe('db2');
  });

  it('settles table picker cancellation and cancels pending catalog loads', async () => {
    jest.useFakeTimers();
    const picker = createPicker();
    const load = jest.fn().mockResolvedValue([]);
    const selection = quickPickSearch(load);
    picker.hide();
    await expect(selection).rejects.toBeInstanceOf(DismissedError);
    jest.runAllTimers();
    expect(load).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('retains the accepted table before disposing the picker', async () => {
    const picker = createPicker();
    const table = { label: 'EMPLOYEES' };
    const selection = quickPickSearch(jest.fn().mockResolvedValue([]), { ignoreIfEmpty: true });
    picker.accept([{ label: 'EMPLOYEES', value: table }]);
    await expect(selection).resolves.toBe(table);
    expect(picker.dispose).toHaveBeenCalledTimes(1);
  });

  it('propagates catalog-loading failure to the command instead of hanging', async () => {
    const picker = createPicker();
    const error = new Error('Catalog permission denied');
    const selection = quickPickSearch(jest.fn().mockRejectedValue(error), { debounceTime: 0 });
    await expect(selection).rejects.toBe(error);
    expect(picker.hide).toHaveBeenCalledTimes(1);
    expect(picker.dispose).toHaveBeenCalledTimes(1);
  });

  it('propagates a synchronous catalog-loader error', async () => {
    const picker = createPicker();
    const error = new Error('Catalog request failed');
    const selection = quickPickSearch(() => { throw error; }, { debounceTime: 0 });
    await expect(selection).rejects.toBe(error);
    expect(picker.dispose).toHaveBeenCalledTimes(1);
  });
});
