const vscode = require('vscode');
const { log } = require('./logger');
const { handleContainerConflict } = require('./container-utils');

/**
 * Opens a folder or workspace in VS Code with proper waiting periods
 * @param {vscode.Uri} uri - The URI to open
 * @param {string} workspaceFile - Optional path to workspace file
 * @param {boolean} forceReuseWindow - Whether to reuse the current window
 */
async function openWorkspaceFolder(uri, workspaceFile = null, forceReuseWindow = true) {
    log(`Opening ${workspaceFile ? 'workspace' : 'folder'}: ${uri.toString()}`);

    try {
        if (workspaceFile) {
            // For workspace files, use remote-containers.openWorkspace
            await vscode.commands.executeCommand(
                'remote-containers.openWorkspace',
                vscode.Uri.file(workspaceFile)
            );
        } else {
            // For folders, use remote-containers.openFolder
            await vscode.commands.executeCommand(
                'remote-containers.openFolder',
                uri,
                { forceReuseWindow }
            );
        }

        // Wait for the operation to complete
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Force a refresh of the explorer view
        await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    } catch (error) {
        // If there's a conflict, try to resolve it
        if (await handleContainerConflict(error)) {
            // Retry the operation after conflict resolution
            if (workspaceFile) {
                await vscode.commands.executeCommand(
                    'remote-containers.openWorkspace',
                    vscode.Uri.file(workspaceFile)
                );
            } else {
                await vscode.commands.executeCommand(
                    'remote-containers.openFolder',
                    uri,
                    { forceReuseWindow }
                );
            }
            // Wait again after retry
            await new Promise(resolve => setTimeout(resolve, 3000));
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        } else {
            throw error; // Re-throw if conflict wasn't resolved
        }
    }
}

module.exports = {
    openWorkspaceFolder
}; 