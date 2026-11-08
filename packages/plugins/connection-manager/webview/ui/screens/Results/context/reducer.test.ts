import { reducer } from './reducer';
import { UIAction } from '../actions';
import { ResultsScreenState } from '../interfaces';

jest.mock('@sqltools/log/src', () => ({ createLogger: () => ({ debug: jest.fn(), warn: jest.fn() }) }));

describe('results loading state', () => {
  const state: ResultsScreenState = {
    loading: true,
    showConsole: false,
    resultTabs: ['SELECT 1', 'SELECT 2'].map((query, index) => ({
      resultId: String(index), requestId: 'request', connId: 'connection',
      results: [], cols: [], messages: [], query,
    })),
    activeTab: 1,
  };

  it('stops loading without replacing existing results or changing the active tab', () => {
    expect(reducer(state, { type: UIAction.SET_STATE, payload: { loading: false } })).toEqual({
      ...state,
      loading: false,
    });
  });

  it('resets the active tab when new results arrive', () => {
    const resultTabs = [state.resultTabs[0]];
    expect(reducer(state, { type: UIAction.RESPONSE_RESULTS, payload: { resultTabs } })).toEqual({
      ...state,
      resultTabs,
      activeTab: 0,
      loading: false,
    });
  });
});
