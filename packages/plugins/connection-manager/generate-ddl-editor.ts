import { window, workspace } from 'vscode';

export async function openDDLDocument(content: string): Promise<void> {
  const document = await workspace.openTextDocument({ language: 'sql', content });
  await window.showTextDocument(document, { preview: false });
}
