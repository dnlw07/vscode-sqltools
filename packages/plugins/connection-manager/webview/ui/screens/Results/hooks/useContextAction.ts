import { UIAction } from '../actions';
import sendMessage from '../../../lib/messages';
import { MenuActions } from '../constants';
import { useCallback } from 'react';
import useCurrentResult from './useCurrentResult';
import useResultsContext from './useResultsContext';

const getCommand = (cmd: string) => `${process.env.EXT_NAMESPACE}.${cmd}`;

const getFormatType = (choice: MenuActions) => Object.values(MenuActions).includes(choice) ? (choice === MenuActions.SaveJSONOption ? 'json' : 'csv') : undefined;

export const openMessagesConsole = () => sendMessage(UIAction.CALL, { command: `${process.env.EXT_NAMESPACE}ViewConsoleMessages.focus` });

export default function useContextAction() {
  const { setState } = useResultsContext();
  const { result, options } = useCurrentResult();

  const openResults = useCallback((choice?: MenuActions.SaveCSVOption | MenuActions.SaveJSONOption | any) => {
    if (!result) return;
    sendMessage(UIAction.CALL, {
      command: getCommand('openResults'),
      args: [{
        ...options,
        formatType: getFormatType(choice),
      }],
    });
  }, [result]);

  const exportResults = useCallback((choice?: MenuActions.SaveCSVOption | MenuActions.SaveJSONOption | any) => {
    if (!result) return;
    sendMessage(UIAction.CALL, {
      command: getCommand('saveResults'),
      args: [{
        ...options,
        formatType: getFormatType(choice),
      }],
    });
  }, [result]);

  return { openResults, exportResults };
}
