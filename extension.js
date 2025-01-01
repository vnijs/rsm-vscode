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
const path = require('path');

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

    // Check for pending container attach from version change
    const pendingAttach = context.globalState.get('pendingContainerAttach');
    if (pendingAttach && (Date.now() - pendingAttach.timestamp < 30000)) {
        log('Found pending container attach, resuming...');
        const { isWindows, windowsContainer, macosContainer } = require('./src/utils/container-utils');
        const containerUtils = isWindows ? windowsContainer : macosContainer;

        // Clear the pending attach immediately to prevent loops
        context.globalState.update('pendingContainerAttach', undefined);

        // Schedule the reattachment to allow VS Code to fully initialize
        setTimeout(async () => {
            try {
                log('Starting container reattachment...');
                const uri = await containerUtils.openInContainer(pendingAttach.path);
                log(`Opening folder with URI: ${uri.toString()}`);

                // First open the folder
                await vscode.commands.executeCommand('vscode.openFolder', uri);
                log('Folder opened, waiting before workspace...');

                // Wait before opening workspace
                setTimeout(async () => {
                    try {
                        const projectName = path.basename(pendingAttach.path);
                        const workspaceFile = path.join(pendingAttach.path, `${projectName}.code-workspace`);
                        log(`Opening workspace file: ${workspaceFile}`);
                        await vscode.commands.executeCommand('vscode.openWorkspace', vscode.Uri.file(workspaceFile));
                        log('Workspace opened successfully');
                    } catch (error) {
                        log(`Error opening workspace: ${error.message}`);
                    }
                }, 5000);
            } catch (error) {
                log(`Error during reattachment: ${error.message}`);
            }
        }, 1000);
    }

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