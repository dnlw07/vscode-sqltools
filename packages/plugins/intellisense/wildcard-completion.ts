import { CompletionItem, CompletionItemKind, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContextValue } from '@sqltools/types';
import Connection from '@sqltools/language-server/src/connection';
import { parseSqlForCompletion } from './sql-completion-parser';

interface WildcardLocation {
  type: string;
  location: {
    first_line: number;
    first_column: number;
  };
  tables?: { identifierChain: { name?: string }[] }[];
}

export async function getWildcardCompletion(
  document: TextDocument,
  currentOffset: number,
  conn: Pick<Connection, 'searchItems' | 'getChildrenForItem'> & Partial<Pick<Connection, 'getDriver'>>
): Promise<CompletionItem | undefined> {
  const text = document.getText();
  const starOffset = text[currentOffset - 1] === '*' ? currentOffset - 1
    : text[currentOffset] === '*' ? currentOffset : -1;
  if (starOffset < 0) return;

  const ast = parseSqlForCompletion(text, starOffset + 1, conn.getDriver?.());
  const locations: WildcardLocation[] = ast.locations || [];
  const wildcard = locations.find(location => location.type === 'asterisk'
    && document.offsetAt({
      line: location.location.first_line - 1,
      character: location.location.first_column - 1,
    }) === starOffset);
  // Multi-table stars and derived relations need more than catalog columns to preserve their semantics.
  if (!wildcard || !wildcard.tables || wildcard.tables.length !== 1) return;
  const identifiers = wildcard.tables[0].identifierChain.map(identifier => identifier.name);
  if (identifiers.some(identifier => !identifier) || identifiers.length > 3) return;

  const beforeStar = text.slice(0, starOffset);
  const qualifier = beforeStar.match(/(?:(?:[A-Za-z_][\w$]*|`(?:``|[^`])+`|"(?:[^"]|"")+"|\[(?:[^\]]|\]\])+])\s*\.\s*)+$/)?.[0] || '';
  if (beforeStar.trimEnd().endsWith('.') && !qualifier) return;

  const label = identifiers[identifiers.length - 1];
  const schema = identifiers[identifiers.length - 2];
  const catalog = identifiers[identifiers.length - 3];
  // Use explorer metadata: completion column searches are usually capped by the driver.
  const matches = await conn.searchItems(ContextValue.TABLE, label, {
    database: schema,
    limit: 2147483647,
  });
  const tables = matches.filter(item => (item.type === ContextValue.TABLE || item.type === ContextValue.VIEW)
    && item.label.toUpperCase() === label.toUpperCase()
    && (!schema || (item.schema || item.database || '').toUpperCase() === schema.toUpperCase())
    && (!catalog || (item.database || '').toUpperCase() === catalog.toUpperCase()));
  if (tables.length !== 1) {
    throw new Error(`Cannot expand wildcard: expected one table for ${identifiers.join('.')}, found ${tables.length}.`);
  }

  const parent = tables[0];
  const children = await conn.getChildrenForItem({ item: parent });
  const columnGroup = children.find(item => item.type === ContextValue.RESOURCE_GROUP && item.childType === ContextValue.COLUMN);
  const items = columnGroup ? await conn.getChildrenForItem({ item: columnGroup, parent }) : children;
  const columns = items.filter(item => item.type === ContextValue.COLUMN);
  if (!columns.length) {
    throw new Error(`Cannot expand wildcard: no column metadata returned for ${identifiers.join('.')}.`);
  }

  const labels = Array.from(new Set(columns.map(column => column.label)));
  const newText = labels.map(name => qualifier + name).join(', ');
  return {
    label: 'Expand * to all columns',
    kind: CompletionItemKind.Snippet,
    detail: `${labels.length} columns from ${identifiers.join('.')}`,
    filterText: '*',
    sortText: '-2',
    preselect: true,
    textEdit: {
      range: Range.create(document.positionAt(starOffset - qualifier.length), document.positionAt(starOffset + 1)),
      newText,
    },
  };
}
