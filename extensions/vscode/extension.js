const vscode = require('vscode');

// Windows needs npm's .cmd shim, as the mcp.json that `hippo init` writes does.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function activate(context) {
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.lm.registerMcpServerDefinitionProvider('hippo-memory', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const { version } = context.extension.packageJSON;
        const server = new vscode.McpStdioServerDefinition('Hippo Memory', NPX, ['-y', 'hippo-memory', 'mcp'], {}, version);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) server.cwd = folder.uri;
        return [server];
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
