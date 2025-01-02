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
    testFilePathsCommand,
    checkContainerConflictsCommand
} = require('./src/utils/commands');
const path = require('path');

// Extension version for tracking changes
const EXTENSION_VERSION = "2024.1.3.106";

// Global configuration storage
let globalState;

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    try {
        // Initialize logger
        initLogger();
        log(`Extension Version: ${EXTENSION_VERSION}`);

        // Show version popup
        vscode.window.showInformationMessage(`RSM VS Code Extension ${EXTENSION_VERSION}`);

        // Store global state
        globalState = context.globalState;

        // Register commands
        const commandRegistrations = [
            { id: 'rsm-vscode.startContainer', handler: () => startContainerCommand(context) },
            { id: 'rsm-vscode.stopContainer', handler: () => stopContainerCommand(context) },
            { id: 'rsm-vscode.startRadiant', handler: startRadiantCommand },
            { id: 'rsm-vscode.startGitGadget', handler: startGitGadgetCommand },
            { id: 'rsm-vscode.cleanPackages', handler: cleanPackagesCommand },
            { id: 'rsm-vscode.setupContainer', handler: setupContainerCommand },
            { id: 'rsm-vscode.debugEnv', handler: debugEnvCommand },
            { id: 'rsm-vscode.changeWorkspace', handler: () => changeWorkspaceCommand(context) },
            { id: 'rsm-vscode.debugContainer', handler: debugContainerCommand },
            { id: 'rsm-vscode.setContainerVersion', handler: () => setContainerVersionCommand(context) },
            { id: 'rsm-vscode.testFilePaths', handler: testFilePathsCommand },
            { id: 'rsm-vscode.checkContainerConflicts', handler: () => checkContainerConflictsCommand(context) }
        ];

        // Register each command with error handling
        commandRegistrations.forEach(({ id, handler }) => {
            try {
                const disposable = vscode.commands.registerCommand(id, handler);
                context.subscriptions.push(disposable);
                log(`Registered command: ${id}`);
            } catch (error) {
                log(`Failed to register command ${id}: ${error.message}`);
                console.error(`Command registration error for ${id}:`, error);
            }
        });

        log('Extension activated');
    } catch (error) {
        console.error('Extension activation error:', error);
        log(`Activation error: ${error.message}`);
        throw error;
    }
}

function deactivate() {
    log('Extension deactivated');
}

module.exports = {
    activate,
    deactivate
};