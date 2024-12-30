const vscode = require('vscode');
const { isWindows, isMacOS } = require('./src/utils/container-utils');
const { windowsPaths, macosPaths } = require('./src/utils/path-utils');
const { initLogger, log } = require('./src/utils/logger');
const { writeFile } = require('./src/utils/file-utils');
const { isInContainer } = require('./src/utils/container-utils');
const {
    startContainerCommand,
    stopContainerCommand,
    startRadiantCommand,
    startGitGadgetCommand,
    cleanPackagesCommand,
    setupContainerCommand,
    debugEnvCommand,
    changeWorkspaceCommand,
    debugContainerCommand,
    setContainerVersionCommand
} = require('./src/utils/commands');

// Extension version for tracking changes
const EXTENSION_VERSION = "2024.1.3.28";

// Global configuration storage
let globalState;

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

function activate(context) {
    // Initialize logger
    initLogger(context);
    
    // Store the global state for later use
    globalState = context.globalState;
    
    // Show version in info bubble only (no modal)
    log(`Extension Version: ${EXTENSION_VERSION}`, true);

    // Add workspace change listener with popup confirmation
    let workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(async event => {
        if (await isInContainer()) {
            const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (currentFolder) {
                const workspacePath = currentFolder.uri.fsPath.replace(/\\/g, '/');
                const oldWorkspace = globalState.get('lastWorkspaceFolder');
                
                const message = `Workspace changing from:\n${oldWorkspace || 'none'}\nto:\n${workspacePath}`;
                const response = await vscode.window.showInformationMessage(
                    message,
                    'Update Saved Location',
                    'Keep Previous'
                );
                
                if (response === 'Update Saved Location') {
                    log(`Updating workspace to: ${workspacePath}`);
                    await globalState.update('lastWorkspaceFolder', workspacePath);
                    vscode.window.showInformationMessage(`Workspace location updated to: ${workspacePath}`);
                } else {
                    log(`Keeping previous workspace: ${oldWorkspace}`);
                }
            }
        }
    });

    // Add window state change listener with feedback
    let windowListener = vscode.window.onDidChangeWindowState(async windowState => {
        if (await isInContainer()) {
            const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (currentFolder) {
                const workspacePath = currentFolder.uri.fsPath;
                const oldWorkspace = globalState.get('lastWorkspaceFolder');
                
                if (oldWorkspace !== workspacePath) {
                    log(`Window changed, current workspace: ${workspacePath}`);
                    log(`Previous workspace was: ${oldWorkspace}`);
                }
            }
        }
    });

    // Add the listeners to subscriptions so they get cleaned up
    context.subscriptions.push(workspaceListener);
    context.subscriptions.push(windowListener);

    // Initial workspace logging
    const lastWorkspace = globalState.get('lastWorkspaceFolder');
    log(`Stored workspace at activation: ${lastWorkspace}`);

    // Register commands
    let startContainer = vscode.commands.registerCommand('rsm-vscode.startContainer', () => startContainerCommand(context));
    let stopContainer = vscode.commands.registerCommand('rsm-vscode.stopContainer', () => stopContainerCommand(context));
    let startRadiant = vscode.commands.registerCommand('rsm-vscode.startRadiant', startRadiantCommand);
    let startGitGadget = vscode.commands.registerCommand('rsm-vscode.startGitGadget', startGitGadgetCommand);
    let cleanPackages = vscode.commands.registerCommand('rsm-vscode.cleanPackages', cleanPackagesCommand);
    let setupContainer = vscode.commands.registerCommand('rsm-vscode.setupContainer', setupContainerCommand);
    let debugEnv = vscode.commands.registerCommand('rsm-vscode.debugEnv', debugEnvCommand);
    let changeWorkspace = vscode.commands.registerCommand('rsm-vscode.changeWorkspace', () => changeWorkspaceCommand(context));
    let debugContainer = vscode.commands.registerCommand('rsm-vscode.debugContainer', debugContainerCommand);
    let setContainerVersion = vscode.commands.registerCommand('rsm-vscode.setContainerVersion', () => setContainerVersionCommand(context));

    // Register all commands
    context.subscriptions.push(startContainer);
    context.subscriptions.push(stopContainer);
    context.subscriptions.push(startRadiant);
    context.subscriptions.push(startGitGadget);
    context.subscriptions.push(cleanPackages);
    context.subscriptions.push(setupContainer);
    context.subscriptions.push(debugEnv);
    context.subscriptions.push(changeWorkspace);
    context.subscriptions.push(debugContainer);
    context.subscriptions.push(setContainerVersion);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};