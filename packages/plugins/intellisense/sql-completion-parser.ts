import sqlAutocompleteParser from 'gethue/parsers/genericAutocompleteParser.js';

interface Token {
  text: string;
  start: number;
  word: boolean;
}

function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
    } else if (sql.startsWith('--', i)) {
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
    } else if (sql.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
    } else {
      const start = i;
      const quote = sql[i];
      if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
        const endQuote = quote === '[' ? ']' : quote;
        i++;
        while (i < sql.length) {
          if (sql[i++] === endQuote) {
            if (sql[i] !== endQuote) break;
            i++;
          }
        }
        result.push({ text: sql.slice(start, i), start, word: false });
      } else if (/[A-Za-z_]/.test(sql[i])) {
        while (i < sql.length && /[\w$#@]/.test(sql[i])) i++;
        result.push({ text: sql.slice(start, i), start, word: true });
      } else {
        result.push({ text: sql[i++], start, word: false });
      }
    }
  }
  return result;
}

function restoreIdentifiers(value: unknown, replacements: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const child: unknown = value[key];
    if (['name', 'alias', 'cte'].includes(key) && typeof child === 'string' && replacements.has(child)) {
      value[key] = replacements.get(child);
    } else {
      restoreIdentifiers(child, replacements);
    }
  }
}

const BIGQUERY_QUALIFIER = /`([^`\r\n]+)`\.([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?/g;

function splitDottedIdentifiers(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.identifierChain) && value.identifierChain.length === 1
    && typeof value.identifierChain[0]?.name === 'string' && value.identifierChain[0].name.includes('.')) {
    value.identifierChain = value.identifierChain[0].name.split('.').map(name => ({ name }));
  }
  for (const key of Object.keys(value)) splitDottedIdentifiers(value[key]);
}

// Hue doesn't end an incomplete statement (e.g. `WHERE ;`) at its semicolon, so statements would bleed into the one
// being completed. Blanking the others keeps offsets and line numbers while isolating the current statement.
function isolateCurrentStatement(text: string, offset: number): string {
  const semicolons = tokens(text).filter(token => token.text === ';').map(token => token.start);
  if (!semicolons.length) return text;
  const previous = semicolons.filter(position => position < offset).pop();
  const next = semicolons.find(position => position >= offset);
  const start = previous === undefined ? 0 : previous + 1;
  const end = next === undefined ? text.length : next + 1;
  const blank = (value: string) => value.replace(/[^\r\n]/g, ' ');
  return blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end));
}

// Hue drops the table of `project`.dataset.table and then mis-parses the following statements of the
// whole document, whatever the active driver is. Moving the closing backtick keeps offsets intact.
export function parseSqlForCompletion(text: string, offset: number, driver?: string) {
  const parserText = isolateCurrentStatement(text.replace(BIGQUERY_QUALIFIER,
    (_match, project, dataset, table) => `\`${project}.${dataset}${table ? `.${table}` : ''}\``), offset);
  const ast = parseNormalizedSql(parserText, offset, driver);
  if (parserText !== text || /^bigquery(?: driver for sqltools)?$/i.test(driver || '')) splitDottedIdentifiers(ast);
  return ast;
}

function parseNormalizedSql(text: string, offset: number, driver?: string) {
  const isDb2 = /^db2(?: driver for sqltools)?$/i.test(driver || '');
  const isPostgres = /postgres/i.test(driver || '');
  if (!isDb2 && !isPostgres) {
    return sqlAutocompleteParser.parseSql(text.slice(0, offset), text.slice(offset));
  }

  const lexemes = tokens(text);
  const originals = new Map<string, string>();
  const replacements = new Map<string, string>();
  let suffix = 0;
  const upperText = text.toUpperCase();
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < lexemes.length; i++) {
    const token = lexemes[i];
    if (!token.word) continue;
    const word = token.text.toUpperCase();
    const previous = lexemes[i - 1]?.text.toUpperCase();
    const next = lexemes[i + 1]?.text;
    let replacement: string;
    let replacementEnd = token.start + token.text.length;
    // Hue doesn't parse PostgreSQL ILIKE or ILIKE ANY(...). Normalize only parser input and
    // retain the original length so completion offsets remain aligned with the user's SQL.
    if (isPostgres && word === 'ILIKE') {
      if (lexemes[i + 1]?.text.toUpperCase() === 'ANY' && lexemes[i + 2]?.text === '(') {
        let depth = 0;
        for (let end = i + 2; end < lexemes.length; end++) {
          if (lexemes[end].text === '(') depth++;
          else if (lexemes[end].text === ')' && --depth === 0) {
            replacementEnd = lexemes[end].start + lexemes[end].text.length;
            break;
          }
        }
        if (replacementEnd > token.start + token.text.length) {
          const prefix = "LIKE 'x'";
          replacement = prefix + text.slice(token.start + prefix.length, replacementEnd).replace(/[^\r\n]/g, ' ');
          while (i + 1 < lexemes.length && lexemes[i + 1].start < replacementEnd) i++;
        } else {
          replacement = 'LIKE ';
        }
      } else {
        replacement = 'LIKE ';
      }
    // Hue supports UNION, but not Db2 EXCEPT. Equal-length input preserves cursor and wildcard locations.
    } else if (isDb2 && word === 'EXCEPT' && previous !== '.' && next !== '.') {
      replacement = 'UNION ';
    } else if (isDb2 && word === 'TABLE' && next !== '(' &&
      !['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'LOCK', 'TEMP', 'TEMPORARY', 'REORG', 'DESCRIBE'].includes(previous) &&
      !(previous === 'ON' && lexemes[i - 2]?.text.toUpperCase() === 'COMMENT')) {
      replacement = originals.get(token.text);
      if (!replacement) {
        replacement = 'TBL00';
        while (upperText.includes(replacement) || replacements.has(replacement)) {
          replacement = `T${(++suffix).toString(36).toUpperCase().padStart(4, '0')}`;
        }
        originals.set(token.text, replacement);
        replacements.set(replacement, token.text);
      }
    }
    if (replacement) {
      parts.push(text.slice(start, token.start), replacement);
      start = replacementEnd;
    }
  }
  parts.push(text.slice(start));
  const parserText = parts.join('');
  const ast = sqlAutocompleteParser.parseSql(parserText.slice(0, offset), parserText.slice(offset));
  restoreIdentifiers(ast, replacements);
  return ast;
}
