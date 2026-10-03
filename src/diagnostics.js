'use strict';

const vscode = require('vscode');
const { version } = require('../package.json');

async function diagnoseUi() {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  const pkg = codex?.packageJSON || {};
  const contributes = pkg.contributes || {};
  const rawViews = contributes.views || {};
  const views = [];
  for (const [container, list] of Object.entries(rawViews)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) views.push({ container, id: item?.id ?? null, name: item?.name ?? null, type: item?.type ?? null, when: item?.when ?? null });
  }
  const commands = await vscode.commands.getCommands(true);
  const report = {
    generatedAt: new Date().toISOString(),
    vscode: { version: vscode.version, language: vscode.env.language, remoteName: vscode.env.remoteName || null },
    schedex: { version },
    codex: codex ? {
      id: codex.id,
      version: pkg.version || null,
      isActive: codex.isActive,
      extensionKind: pkg.extensionKind || null,
      viewsContainers: contributes.viewsContainers || null,
      views,
      declaredCommands: Array.isArray(contributes.commands) ? contributes.commands.map((c) => c?.command).filter(Boolean).sort() : []
    } : null,
    registeredRelevantCommands: commands.filter((id) => /^(chatgpt|codex|openai)[.:-]/i.test(id)).sort()
  };
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
  await vscode.window.showTextDocument(doc, { preview: false });
}


module.exports = { diagnoseUi };
