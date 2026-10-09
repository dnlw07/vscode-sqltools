import { window, QuickPickItem, QuickPickOptions, QuickPick } from 'vscode';
import { DismissedError } from '@sqltools/util/exception';
import { createLogger } from '@sqltools/log/src';

const log = createLogger('quickpick');
export type ExtendedQuickPickOptions<T extends QuickPickItem = QuickPickItem | any> = Partial<
  QuickPickOptions & {
    title: QuickPick<T>['title'];
    placeHolderDisabled?: QuickPick<T>['placeholder'];
    buttons?: QuickPick<T>['buttons'];
    debounceTime: number;
    ignoreIfEmpty: boolean;
  }
>;

export async function quickPick<T = QuickPickItem | any>(
  options: ((QuickPickItem & { value?: any }) | string)[],
  prop?: string,
  quickPickOptions?: ExtendedQuickPickOptions
): Promise<QuickPickItem | any> {
  const items =
    options.length > 0 && typeof options[0] === 'object'
      ? <QuickPickItem[]>options
      : options.map<QuickPickItem>(value => ({
          value,
          label: value.toString(),
        }));

  const qPick = window.createQuickPick();
  const sel = await new Promise<QuickPickItem | any>(resolve => {
    const { placeHolderDisabled, ...qPickOptions } = quickPickOptions || ({} as ExtendedQuickPickOptions);
    qPick.onDidHide(() => {
      resolve(undefined);
      qPick.dispose();
    });
    qPick.onDidChangeSelection((selection = []) => {
      resolve(qPickOptions.canPickMany ? selection : selection[0]);
      qPick.hide();
    });
    qPick.onDidTriggerButton((btn: any) => {
      if (btn.cb) btn.cb();
      qPick.hide();
    });

    // Handle case discrepancy between our property name and the vscode one
    qPick.placeholder = qPickOptions.placeHolder;
    delete qPickOptions.placeHolder;

    Object.keys(qPickOptions).forEach(k => {
      qPick[k] = qPickOptions[k];
    });
    qPick.items = items;

    if (!items.length) qPick.placeholder = placeHolderDisabled || qPick.placeholder;

    qPick.title = `${qPickOptions.title || 'Items'} (${items.length})`;

    qPick.show();
  });
  if (!sel || (prop && !sel[prop])) throw new DismissedError();
  return <T>(prop ? sel[prop] : sel);
}

export async function quickPickSearch<T = any>(
  loadOptions: (search: string) => PromiseLike<(({ label: string; value?: T }))[]>,
  quickPickOptions: ExtendedQuickPickOptions = {},
): Promise<T> {
  const qPick = window.createQuickPick();
  qPick.placeholder = qPick.placeholder || 'Type something to search...';
  const sel = await new Promise<any[]>((resolve, reject) => {
    const { placeHolderDisabled, debounceTime = 150, ignoreIfEmpty = false, ...qPickOptions } = quickPickOptions;
    let searchTimeout = null;
    let hidden = false;
    const onChangeValue = (search = '') => {
      qPick.busy = true;
      if (ignoreIfEmpty && (!search || !search.trim())) {
        qPick.items = [];
        qPick.busy = false;
        return;
      }
      clearInterval(searchTimeout);
      searchTimeout = setTimeout(() => {
        const catchFn = error => {
          if (hidden) return;
          log.error('search error: %O', error);
          reject(error);
          qPick.hide();
        };
        const thenFn = (options: any[]) => {
          if (hidden) return;
          qPick.busy = false;
          qPick.items = options.length > 0 && typeof options[0] === 'object'
            ? <QuickPickItem[]>options.map(o => ({ ...o, value: o, label: o.value || o.label }))
            : options.map<QuickPickItem>(value => ({ value, label: value.toString() }));
          qPick.title = `${qPickOptions.title || 'Items'} (${qPick.items.length})`;
        };
        Promise.resolve().then(() => loadOptions(search)).then(thenFn).catch(catchFn);
      }, debounceTime);
    };
    qPick.onDidChangeValue(onChangeValue);
    qPick.onDidHide(() => {
      hidden = true;
      clearTimeout(searchTimeout);
      resolve(undefined);
      qPick.dispose();
    });
    qPick.onDidChangeSelection((selection: (QuickPickItem & { value: any })[] = []) => {
      resolve(selection.map(s => s.value));
      qPick.hide();
    });
    qPick.onDidTriggerButton((btn: any) => {
      if (btn.cb)
        btn.cb();
      qPick.hide();
    });
    Object.keys(qPickOptions).forEach(k => {
      qPick[k] = qPickOptions[k];
    });

    if (!ignoreIfEmpty) onChangeValue();
    qPick.show();
  });

  if (!sel || (quickPickOptions.canPickMany && sel.length === 0)) throw new DismissedError();

  if (quickPickOptions.canPickMany) return sel as any as T;

  return sel.pop() as T;
}
