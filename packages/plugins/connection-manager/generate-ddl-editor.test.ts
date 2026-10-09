import { commands, window, workspace } from 'vscode';
import { openDDLDocument } from './generate-ddl-editor';
import manifest from '../../extension/package.json';

jest.mock('vscode', () => ({
  workspace: { openTextDocument: jest.fn() },
  window: { showTextDocument: jest.fn() },
  commands: { executeCommand: jest.fn() },
}), { virtual: true });

describe('Generate DDL editor and contributions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('opens a new SQL document, not a preview tab, without executing SQL', async () => {
    const document = { uri: 'untitled:DDL' };
    (workspace.openTextDocument as jest.Mock).mockResolvedValue(document);
    const ddl = 'CREATE TABLE "APP"."T" ("ID" INTEGER);';
    await openDDLDocument(ddl);
    expect(workspace.openTextDocument).toHaveBeenCalledTimes(1);
    expect(workspace.openTextDocument).toHaveBeenCalledWith({ language: 'sql', content: ddl });
    expect(window.showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('does not present an editor when document creation fails', async () => {
    (workspace.openTextDocument as jest.Mock).mockRejectedValue(new Error('Editor failure'));
    await expect(openDDLDocument('DDL')).rejects.toThrow('Editor failure');
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });

  it('contributes Generate DDL next to Describe Table and keeps it available in the palette', () => {
    expect(manifest.contributes.commands).toContainEqual({
      title: 'Generate DDL', command: 'sqltools.generateDDL', category: 'SQLTools Connection',
    });
    const menu = manifest.contributes.menus['view/item/context'];
    const describeIndex = menu.findIndex(item => item.command === 'sqltools.describeTable');
    expect(menu[describeIndex + 1]).toEqual({
      command: 'sqltools.generateDDL',
      when: 'view == sqltoolsViewConnectionExplorer && viewItem == connection.table',
      group: 'navigation@2.1',
    });
    expect(manifest.contributes.menus.commandPalette.some(item => item.command === 'sqltools.generateDDL'
      && item.when === 'false')).toBe(false);
    expect(manifest.contributes.keybindings.some(item => item.command === 'sqltools.generateDDL')).toBe(false);
  });
});
