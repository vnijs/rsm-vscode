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
    setContainerVersionCommand,
    testFilePathsCommand
} = require('./src/utils/commands');

// Extension version for tracking changes
const EXTENSION_VERSION = "2024.1.3.68";

// Global configuration storage
let globalState;

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // Initialize logger
    initLogger();
    log(`Extension Version: ${EXTENSION_VERSION}`);

    // Store global state
    globalState = context.globalState;

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rsm-vscode.startContainer', () => startContainerCommand(context)),
        vscode.commands.registerCommand('rsm-vscode.stopContainer', () => stopContainerCommand(context)),
        vscode.commands.registerCommand('rsm-vscode.startRadiant', startRadiantCommand),
        vscode.commands.registerCommand('rsm-vscode.startGitGadget', startGitGadgetCommand),
        vscode.commands.registerCommand('rsm-vscode.cleanPackages', cleanPackagesCommand),
        vscode.commands.registerCommand('rsm-vscode.setupContainer', setupContainerCommand),
        vscode.commands.registerCommand('rsm-vscode.debugEnv', debugEnvCommand),
        vscode.commands.registerCommand('rsm-vscode.changeWorkspace', () => changeWorkspaceCommand(context)),
        vscode.commands.registerCommand('rsm-vscode.debugContainer', debugContainerCommand),
        vscode.commands.registerCommand('rsm-vscode.setContainerVersion', () => setContainerVersionCommand(context)),
        vscode.commands.registerCommand('rsm-vscode.testFilePaths', testFilePathsCommand)
    );

    log('Extension activated');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};