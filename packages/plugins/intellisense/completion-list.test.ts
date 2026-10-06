import { CompletionItem } from 'vscode-languageserver';
import { createCompletionList, MAX_OBJECT_COMPLETIONS } from './completion-list';

describe('completion result limits', () => {
  it('limits object suggestions and marks the result incomplete when more matches exist', () => {
    const objects = Array.from({ length: 72000 }, (_, index) => <CompletionItem>{
      label: `TABLE_${index}`,
    });
    const keyword: CompletionItem = { label: 'SELECT' };

    const result = createCompletionList(objects, [keyword]);

    expect(result.items).toHaveLength(MAX_OBJECT_COMPLETIONS + 1);
    expect(result.items.slice(0, MAX_OBJECT_COMPLETIONS).every(item => item.label.startsWith('TABLE_'))).toBe(true);
    expect(result.items[MAX_OBJECT_COMPLETIONS]).toBe(keyword);
    expect(result.isIncomplete).toBe(true);
  });

  it('does not mark a result incomplete when all object suggestions fit', () => {
    const result = createCompletionList([{ label: 'TABLE_A' }], [{ label: 'SELECT' }]);

    expect(result).toEqual({
      isIncomplete: false,
      items: [{ label: 'TABLE_A' }, { label: 'SELECT' }],
    });
  });

  it('limits raw completion results consistently', () => {
    const results = Array.from({ length: 72000 }, (_, index) => <CompletionItem>{
      label: `OBJECT_${index}`,
    });

    const result = createCompletionList(results, []);

    expect(result.items).toHaveLength(MAX_OBJECT_COMPLETIONS);
    expect(result.isIncomplete).toBe(true);
  });
});
