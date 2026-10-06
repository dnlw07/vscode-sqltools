export default class QueryExecutionTracker {
  private activeQueries = new Map<string, number>();

  start(connectionId: string) {
    const activeCount = this.activeQueries.get(connectionId) || 0;
    this.activeQueries.set(connectionId, activeCount + 1);
    return activeCount > 0;
  }

  finish(connectionId: string) {
    const activeCount = this.activeQueries.get(connectionId);
    if (activeCount === undefined) {
      throw new Error(`No active query found for connection '${connectionId}'.`);
    }

    if (activeCount === 1) {
      this.activeQueries.delete(connectionId);
    } else {
      this.activeQueries.set(connectionId, activeCount - 1);
    }
  }
}
