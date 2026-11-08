export class SqlExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlExecutionPolicyError';
  }
}

export class SqlExecutionBlockedError extends SqlExecutionPolicyError {}

/**
 * Replace comments and string literals without joining the SQL tokens on either
 * side. Quoted identifiers are retained because they can identify SQL objects.
 */
export function maskSqlNonCode(sql: string, dialect: string): string {
  const chars = sql.split('');
  const isPostgres = /postgres/i.test(dialect);
  const isMysql = /mysql|mariadb/i.test(dialect);
  const isBigQuery = /bigquery/i.test(dialect);
  const isOracle = /oracle/i.test(dialect);
  const mask = (start: number, end: number) => {
    for (let j = start; j < end; j++) {
      if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' ';
    }
  };
  let i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i) || ((isMysql || isBigQuery) && sql[i] === '#')) {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      mask(start, i);
      continue;
    }
    if (sql.startsWith('/*', i)) {
      // MySQL executable comments are SQL, not ordinary comments.
      if (isMysql && (sql.startsWith('/*!', i) || sql.startsWith('/*M!', i))) {
        const opening = sql.startsWith('/*M!', i) ? 4 : 3;
        const end = sql.indexOf('*/', i + opening);
        const contentEnd = end < 0 ? sql.length : end;
        const version = /^\d{5,6}\s*/.exec(sql.slice(i + opening, contentEnd));
        mask(i, i + opening + (version ? version[0].length : 0));
        if (end >= 0) mask(end, end + 2);
        i += opening + (version ? version[0].length : 0);
        continue;
      }
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      mask(start, i);
      continue;
    }
    if (isPostgres && sql[i] === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
      const delimiter = /^\$(?:[a-zA-Z_][\w]*)?\$/.exec(sql.slice(i));
      if (delimiter) {
        const closing = sql.indexOf(delimiter[0], i + delimiter[0].length);
        i = closing < 0 ? sql.length : closing + delimiter[0].length;
        mask(start, i);
        continue;
      }
    }
    if (isOracle && /[qQ]/.test(sql[i]) && sql[i + 1] === "'" && i + 2 < sql.length
      && (i === 0 || !/[\w$#]/.test(sql[i - 1]))) {
      const delimiters: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };
      const closing = (delimiters[sql[i + 2]] || sql[i + 2]) + "'";
      const end = sql.indexOf(closing, i + 3);
      i = end < 0 ? sql.length : end + 2;
      mask(start, i);
      continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      const isString = quote === "'" || (quote === '"' && (isMysql || isBigQuery));
      const terminator = quote === '[' ? ']' : quote;
      const triple = isBigQuery && isString && sql.slice(i, i + 3) === quote.repeat(3);
      const endQuote = triple ? quote.repeat(3) : terminator;
      const postgresEscape = isPostgres && quote === "'" && i > 0 && /[eE]/.test(sql[i - 1])
        && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      i += endQuote.length;
      while (i < sql.length) {
        if (isString && (postgresEscape || isMysql || isBigQuery) && sql[i] === '\\') {
          i += Math.min(2, sql.length - i);
        } else if (sql.startsWith(endQuote, i)) {
          i += endQuote.length;
          if (!triple && sql[i] === terminator) i++;
          else break;
        } else i++;
      }
      if (isString) mask(start, i);
      continue;
    }
    i++;
  }
  return chars.join('');
}

export function assertSqlAllowed(sql: string, patterns: readonly string[], dialect: string): void {
  if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) {
    throw new SqlExecutionPolicyError('SQL blocking patterns must be an array of strings.');
  }
  const expressions = patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new SqlExecutionPolicyError(`Invalid SQL blocking pattern ${index + 1}: ${error.message}`);
    }
  });
  if (!expressions.length) return;
  const executableSql = maskSqlNonCode(sql, dialect);
  const matched = expressions.findIndex(expression => expression.test(executableSql));
  if (matched >= 0) {
    throw new SqlExecutionBlockedError(`SQL execution blocked by pattern ${matched + 1}.`);
  }
}
