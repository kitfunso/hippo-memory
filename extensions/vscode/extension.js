// Adds hippo's MCP server to VS Code, so Copilot agent mode gets hippo's memory tools with no mcp.json edit.
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
        // hippo looks for the project's .hippo store from its working folder upward.
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) server.cwd = folder.uri;
        return [server];
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
