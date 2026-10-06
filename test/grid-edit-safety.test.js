const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const drivers = {
  PostgreSQL: 'vscode-sqltools/packages/driver.pg/src/ls/driver.ts',
  DB2: 'db2-sqltools/src/ls/driver.ts',
  Oracle: 'sqltools-Oracle-driver/src/ls/driver.ts',
  BigQuery: 'sqltools-bigquery-driver/src/ls/driver.ts',
};

function loadDriver(file) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let method;
  ts.forEachChild(ast, node => {
    if (!ts.isClassDeclaration(node)) return;
    for (const member of node.members) {
      if (member.name && member.name.getText(ast) === 'applyEdits') method = member.getText(ast);
    }
  });
  assert.ok(method);
  const context = { exports: {} };
  const compiled = ts.transpileModule(`export default class Driver { ${method} }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(compiled, context);
  return new context.exports.default();
}

function fixture(name, file, counts = [1, 1], affected = [1, 1], countError = false) {
  const driver = loadDriver(file);
  const events = [];
  const statements = [];
  const execute = (sql, params) => {
    if (sql.startsWith('SELECT')) {
      events.push('COUNT');
      statements.push({ sql, params });
      if (countError) throw new Error('Count failed');
      return { rows: [{ matching_count: counts.shift() }] };
    }
    if (sql.startsWith('UPDATE')) {
      events.push('UPDATE');
      statements.push({ sql, params });
      const count = affected.shift();
      return { rowCount: count, rowsAffected: count, metadata: { statistics: { query: { dmlStats: { updatedRowCount: String(count) } } } } };
    }
    if (sql.startsWith('BEGIN')) events.push('BEGIN');
    if (sql.startsWith('COMMIT')) events.push('COMMIT');
    if (sql.startsWith('ROLLBACK')) events.push('ROLLBACK');
    return {};
  };
  const conn = {
    async query(sql) { return execute(typeof sql === 'string' ? sql : sql.text, sql.values); },
    async execute(sql, params) { return execute(sql, params); },
    async beginTransaction() { events.push('BEGIN'); },
    async commitTransaction() { events.push('COMMIT'); },
    async rollbackTransaction() { events.push('ROLLBACK'); },
    async commit() { events.push('COMMIT'); },
    async rollback() { events.push('ROLLBACK'); },
    async close() { events.push('CLOSE'); },
    release() { events.push('RELEASE'); },
    prepare(sql, callback) {
      callback(null, {
        executeNonQuery(params, done) {
          try { done(null, execute(sql, params).rowCount); } catch (error) { done(error); }
        },
        closeSync() {},
      });
    },
  };
  if (name === 'DB2') {
    conn.query = (query, callback) => {
      try { callback(null, execute(query.sql, query.params).rows); } catch (error) { callback(error); }
    };
  }
  const scriptConnection = {
    async commit() { throw new Error('Script connection committed'); },
    async rollback() { throw new Error('Script connection rolled back'); },
    async close() { throw new Error('Script connection closed'); },
  };
  driver.connection = Promise.resolve(scriptConnection);
  driver.open = async () => name === 'PostgreSQL' ? { connect: async () => conn } : name === 'Oracle' ? scriptConnection : conn;
  driver.credentials = { username: 'user', password: 'secret', connectString: 'service' };
  driver.pooled = false;
  driver.privilege = 'Normal';
  driver.privilegeMap = { Normal: 0 };
  driver.lib = { OUT_FORMAT_OBJECT: 1, async getConnection(options) {
    if (!driver.pooled) assert.deepEqual({ ...options }, { user: 'user', password: 'secret', connectString: 'service', privilege: 0 });
    return conn;
  } };
  driver._ensureSession = async () => 'test-session';
  driver._buildConnectionProperties = () => [];
  driver._runSessionQuery = async (_client, _options, sql, params) => execute(sql, params);
  return { driver, events, statements, scriptConnection };
}

const edit = id => ({ table: { label: 'orders', schema: 'app' }, primaryKey: { ID: id, NOTE: null }, changes: { ID: id + 10, STATUS: 'new' } });

for (const [name, relative] of Object.entries(drivers)) {
  const file = path.join(root, relative);
  const options = { skip: !fs.existsSync(file) };
  for (const count of [0, 2, undefined]) {
    test(`${name}: second WHERE count ${count} prevents all updates`, options, async () => {
      const { driver, events } = fixture(name, file, [1, count]);
      const result = await driver.applyEdits([edit(1), edit(2)], {});
      assert.equal(result.success, false);
      assert.equal(result.failedIndex, 1);
      assert.ok(events.includes('ROLLBACK'));
      assert.ok(!events.includes('UPDATE'));
      assert.ok(!events.includes('COMMIT'));
    });
  }
  test(`${name}: all checks precede writes, and predicates/bindings are reused`, options, async () => {
    const { driver, events, statements, scriptConnection } = fixture(name, file, ['1', 1]);
    const result = await driver.applyEdits([edit(1), edit(2)], {});
    assert.equal(result.success, true, result.error);
    assert.deepEqual(events.filter(event => ['COUNT', 'UPDATE', 'COMMIT'].includes(event)), ['COUNT', 'COUNT', 'UPDATE', 'UPDATE', 'COMMIT']);
    for (let index = 0; index < 2; index++) {
      const count = statements[index];
      const update = statements[index + 2];
      assert.equal(count.sql.split(' WHERE ')[1], update.sql.split(' WHERE ')[1]);
      if (name === 'Oracle' || name === 'BigQuery') {
        assert.ok(count.sql.includes(' IS NULL'));
        assert.equal(count.params.w0, index + 1);
        assert.equal(update.params.w0, index + 1);
        assert.ok(!('w1' in count.params));
        assert.ok(!('s0' in count.params));
        assert.equal(update.params.s0, index + 11);
      } else {
        assert.deepEqual(Array.from(count.params), [index + 1, null]);
        assert.deepEqual(Array.from(update.params), name === 'DB2' ? [index + 11, 'new', index + 1, null] : [index + 1, null, index + 11, 'new']);
      }
    }
    if (name === 'Oracle') {
      assert.equal(await driver.connection, scriptConnection);
      assert.ok(events.includes('CLOSE'));
    }
    if (name === 'PostgreSQL') assert.ok(events.includes('RELEASE'));
  });
  test(`${name}: changed matching after preflight rolls the batch back`, options, async () => {
    const { driver, events } = fixture(name, file, [1, 1], [1, 2]);
    const result = await driver.applyEdits([edit(1), edit(2)], {});
    assert.equal(result.success, false);
    assert.equal(result.failedIndex, 1);
    assert.ok(events.includes('ROLLBACK'));
    assert.ok(!events.includes('COMMIT'));
  });
  test(`${name}: count failures reject without writes`, options, async () => {
    const { driver, events } = fixture(name, file, [1], [1], true);
    assert.equal((await driver.applyEdits([edit(1)], {})).success, false);
    assert.ok(!events.includes('UPDATE'));
    assert.ok(!events.includes('COMMIT'));
  });
  test(`${name}: invalid match value rejects the entire batch before beginning`, options, async () => {
    const { driver, events } = fixture(name, file);
    const invalid = edit(2);
    invalid.primaryKey.ID = undefined;
    const result = await driver.applyEdits([edit(1), invalid], {});
    assert.equal(result.success, false);
    assert.equal(result.failedIndex, 1);
    assert.ok(!events.includes('BEGIN'));
    assert.ok(!events.includes('COUNT'));
    assert.ok(!events.includes('UPDATE'));
  });
  test(`${name}: empty batch opens no transaction`, options, async () => {
    const { driver, events } = fixture(name, file);
    assert.equal((await driver.applyEdits([], {})).success, true);
    assert.deepEqual(events, []);
  });
  if (name === 'Oracle') {
    test('Oracle: pooled grid connection is separate from script session', options, async () => {
      const { driver, events } = fixture(name, file, [1], [1]);
      driver.pooled = true;
      assert.equal((await driver.applyEdits([edit(1)], {})).success, true);
      assert.ok(events.includes('CLOSE'));
    });
  }
}

test('grid preflight failure identifies the displayed row and retains pending edits', () => {
  const file = path.join(root, 'vscode-sqltools/packages/plugins/connection-manager/webview/ui/screens/Results/components/Table/index.tsx');
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'saveEdits') callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  let receiveResult;
  let sent;
  let message;
  let saving;
  const pending = new Map([['2:ID', { rowindex: 2, colname: 'ID', oldValue: 3, newValue: 30 }]]);
  const context = {
    saving: false, editable: true, hasPrimaryKey: true,
    pendingEditsRef: { current: pending },
    rows: [{ ID: 1 }, { ID: 2 }, { ID: 30 }],
    columnMeta: [{ name: 'ID', sourceColumn: 'ID', table: 'orders', schema: 'app', isPk: true }],
    requestId: 'test', process: { env: { EXT_NAMESPACE: 'sqltools' } },
    UIAction: { CALL: 'call', CALL_RESULT: 'result' },
    window: { addEventListener(_event, handler) { receiveResult = handler; }, removeEventListener() {} },
    sendMessage(_action, payload) { sent = payload; },
    setSaving(value) { saving = value; },
    setSaveError(value) { message = value; },
    setPendingEditCount() { throw new Error('Pending edits must not be cleared'); },
  };
  vm.runInNewContext(ts.transpileModule(`const run = ${callback}; run();`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  receiveResult({ data: { action: 'result', payload: { correlationId: sent.correlationId, result: { success: false, failedIndex: 0, error: 'WHERE matches 2 rows' } } } });
  assert.equal(message, 'Row 3: WHERE matches 2 rows');
  assert.equal(saving, false);
  assert.equal(pending.size, 1);
  assert.equal(context.rows[2].ID, 30);
  assert.equal(sent.args[0][0].primaryKey.ID, 3);
  assert.equal(sent.args[0][0].changes.ID, 30);
});