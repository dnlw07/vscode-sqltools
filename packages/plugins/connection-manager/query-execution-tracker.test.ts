import QueryExecutionTracker from './query-execution-tracker';
import getResultsRequestId from './results-request-id';

describe('QueryExecutionTracker', () => {
  it('marks concurrent queries on the same connection for isolated results', () => {
    const tracker = new QueryExecutionTracker();

    expect(tracker.start('connection-a')).toBe(false);
    expect(tracker.start('connection-a')).toBe(true);
    expect(tracker.start('connection-b')).toBe(false);

    tracker.finish('connection-a');
    expect(tracker.start('connection-a')).toBe(true);

    tracker.finish('connection-a');
    tracker.finish('connection-a');
    expect(tracker.start('connection-a')).toBe(false);
    tracker.finish('connection-a');
    tracker.finish('connection-b');
  });

  it('rejects finishing a connection with no active query', () => {
    const tracker = new QueryExecutionTracker();

    expect(() => tracker.finish('connection-a')).toThrow(
      "No active query found for connection 'connection-a'."
    );
  });

  it('uses separate results request IDs only for overlapping queries', () => {
    const tracker = new QueryExecutionTracker();
    const connectionId = 'connection-a';

    const firstOverlapping = tracker.start(connectionId);
    const firstRequestId = getResultsRequestId(connectionId, undefined, 'connection', firstOverlapping);
    const secondOverlapping = tracker.start(connectionId);
    const secondRequestId = getResultsRequestId(connectionId, undefined, 'connection', secondOverlapping);

    expect(firstRequestId).toBe(connectionId);
    expect(secondRequestId).not.toBe(connectionId);
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(getResultsRequestId(connectionId, 'existing-request', 'connection', true)).not.toBe('existing-request');
    expect(getResultsRequestId(connectionId, 'existing-request', 'connection', false)).toBe('existing-request');

    tracker.finish(connectionId);
    tracker.finish(connectionId);
    expect(getResultsRequestId(connectionId, undefined, 'connection', tracker.start(connectionId))).toBe(connectionId);
    tracker.finish(connectionId);
  });
});
