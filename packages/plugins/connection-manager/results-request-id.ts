import generateId from '@sqltools/util/internal-id';

export default function getResultsRequestId(
  connId: string,
  reuseId: string | undefined,
  reuseTabs: 'never' | 'connection',
  forceNew: boolean
) {
  if (forceNew) return generateId();
  return reuseId || (reuseTabs === 'connection' ? connId : generateId());
}
