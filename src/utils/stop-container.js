const vscode = require('vscode');
const { isWindows } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { isInContainer } = require('./container-utils');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

async function stopContainerCommand(context) {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Not connected to the RSM container');
        return;
    }

    try {
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (currentFolder) {
            const workspacePath = currentFolder.uri.fsPath;
            log(`Storing workspace before detaching: ${workspacePath}`);
            await context.globalState.update('lastWorkspaceFolder', workspacePath);
        }

        if (currentFolder) {
            const containerPath = currentFolder.uri.path;
            log(`Container path: ${containerPath}`);

            const localPath = await paths.toLocalPath(containerPath);
            log(`Local path: ${localPath}`);

            await vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(localPath),
                { forceReuseWindow: true }
            );

            await new Promise(resolve => setTimeout(resolve, 2000));

            // Get container name from current folder
            const { stdout: containerName } = await execAsync('docker ps --format "{{.Names}}" | grep rsm-msba-k8s');
            if (containerName) {
                log(`Stopping container: ${containerName}`);
                await execAsync(`docker stop ${containerName.trim()}`);
                vscode.window.showInformationMessage('Container stopped successfully');
            } else {
                log('No container found to stop');
            }
        } else {
            throw new Error('No workspace folder found');
        }
    } catch (error) {
        log(`Failed to stop container: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
    }
}

module.exports = {
    stopContainerCommand
}; 