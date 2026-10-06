import { CompletionItem, CompletionList } from 'vscode-languageserver';

export const MAX_OBJECT_COMPLETIONS = 500;
export const COMPLETION_LOOKAHEAD = MAX_OBJECT_COMPLETIONS + 1;

export function createCompletionList(
  objectCompletions: CompletionItem[],
  otherCompletions: CompletionItem[] = [],
  limit = MAX_OBJECT_COMPLETIONS
): CompletionList {
  return {
    isIncomplete: objectCompletions.length > limit,
    items: objectCompletions.slice(0, limit).concat(otherCompletions),
  };
}
