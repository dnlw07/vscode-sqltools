export type QueryBlockMarker = 'block' | 'cell' | null;

export interface QueryBlock {
  startOffset: number;
  endOffset: number;
  text: string;
  marker: QueryBlockMarker;
  connectionName?: string;
}

const BLOCK_MARKER_REGEX = /^[ \t]*-{2,}[ \t]*(?:(@block)\b[^\r\n]*|%%(?:[ \t]+([^\r\n]*?))?)[ \t]*(?=\r?$)/gim;
const BLOCK_MARKER_LINE_REGEX = /^[ \t]*-{2,}[ \t]*(?:@block\b[^\r\n]*|%%(?:[ \t]+[^\r\n]*?)?)[ \t]*(?=\r?$)/gim;

export function parseQueryBlocks(text: string): QueryBlock[] {
  const markers: Array<{ offset: number; marker: QueryBlockMarker; connectionName?: string }> = [];
  const matcher = new RegExp(BLOCK_MARKER_REGEX.source, BLOCK_MARKER_REGEX.flags);
  let match: RegExpExecArray;

  while ((match = matcher.exec(text)) !== null) {
    const lineStart = match.index;
    const isCell = !match[1];
    markers.push({
      offset: lineStart,
      marker: isCell ? 'cell' : 'block',
      connectionName: isCell ? (match[2] || '').trim() || undefined : undefined,
    });
  }

  if (markers.length === 0) {
    return [{ startOffset: 0, endOffset: text.length, text, marker: null }];
  }

  const blocks: QueryBlock[] = [];
  if (markers[0].offset > 0) {
    blocks.push({
      startOffset: 0,
      endOffset: markers[0].offset,
      text: text.slice(0, markers[0].offset),
      marker: null,
    });
  }

  markers.forEach((marker, index) => {
    const endOffset = markers[index + 1]?.offset ?? text.length;
    blocks.push({
      ...marker,
      startOffset: marker.offset,
      endOffset,
      text: text.slice(marker.offset, endOffset),
    });
  });

  return blocks;
}

export function getQueryBlockAtOffset(blocks: QueryBlock[], offset: number): QueryBlock | undefined {
  return blocks.find((block, index) =>
    offset >= block.startOffset &&
    (offset < block.endOffset || (index === blocks.length - 1 && offset === block.endOffset))
  );
}

export function stripQueryBlockMarkers(text: string) {
  return text.replace(BLOCK_MARKER_LINE_REGEX, '');
}

export function getQueryBlockConnectionName(block: QueryBlock, documentText: string) {
  if (block.connectionName) return block.connectionName;

  const blockConnection = (block.text.match(/@conn\s*(.+)$/m) || [])[1];
  if (blockConnection && blockConnection.trim()) return blockConnection.trim();

  const firstLine = documentText.split(/\r?\n/, 1)[0] || '';
  const defaultConnection = (firstLine.match(/@conn\s*(.+)$/) || [])[1];
  return defaultConnection && defaultConnection.trim() || undefined;
}
