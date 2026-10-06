import { getQueryBlockAtOffset, getQueryBlockConnectionName, parseQueryBlocks, stripQueryBlockMarkers } from './blocks';

describe('SQL query blocks', () => {
  it('parses legacy blocks and named or unassigned cells', () => {
    const text = [
      'SELECT 0;',
      '-- @block legacy',
      '-- @conn legacy-db',
      'SELECT 1;',
      '-- %% named-db',
      'SELECT 2;',
      '-- %%',
      'SELECT 3;',
    ].join('\n');

    const blocks = parseQueryBlocks(text);

    expect(blocks.map(({ marker, connectionName, text: blockText }) => ({
      marker,
      connectionName,
      text: blockText.trim(),
    }))).toEqual([
      { marker: null, connectionName: undefined, text: 'SELECT 0;' },
      { marker: 'block', connectionName: undefined, text: '-- @block legacy\n-- @conn legacy-db\nSELECT 1;' },
      { marker: 'cell', connectionName: 'named-db', text: '-- %% named-db\nSELECT 2;' },
      { marker: 'cell', connectionName: undefined, text: '-- %%\nSELECT 3;' },
    ]);
  });

  it('resolves offsets at block boundaries to the block starting at that boundary', () => {
    const text = 'SELECT 0;\n-- %% db\nSELECT 1;';
    const blocks = parseQueryBlocks(text);
    const secondBlock = text.indexOf('-- %%');

    expect(getQueryBlockAtOffset(blocks, secondBlock)).toBe(blocks[1]);
    expect(getQueryBlockAtOffset(blocks, text.length)).toBe(blocks[1]);
    expect(getQueryBlockAtOffset(blocks, -1)).toBeUndefined();
  });

  it('strips both supported block marker lines from executable SQL', () => {
    expect(stripQueryBlockMarkers('-- @block old\nSELECT 1;\n-- %% new-db\nSELECT 2;'))
      .toBe('\nSELECT 1;\n\nSELECT 2;');
  });

  it('prefers a cell assignment, then a block @conn, then the file-level @conn', () => {
    const text = [
      '-- @conn file-db',
      'SELECT 0;',
      '-- @block legacy',
      '-- @conn legacy-db',
      'SELECT 1;',
      '-- %% cell-db',
      '-- @conn legacy-cell-db',
      'SELECT 2;',
      '-- %%',
      'SELECT 3;',
    ].join('\n');
    const blocks = parseQueryBlocks(text);

    expect(blocks.map(block => getQueryBlockConnectionName(block, text))).toEqual([
      'file-db',
      'legacy-db',
      'cell-db',
      'file-db',
    ]);
  });
});
