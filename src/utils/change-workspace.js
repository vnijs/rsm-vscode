const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const { isWindows, isInContainer } = require('./container-utils');
const { log } = require('./logger');
const { getWSLUsername } = require('./wsl-utils');
const { getProjectName, createDevcontainerContent, createTemporaryDevContainer, cleanupTemporaryDevContainer } = require('./file-utils');
const { openWorkspaceFolder } = require('./workspace-utils');
const { stopContainerIfNeeded } = require('./container-utils');
const { createConfigFiles } = require('./file-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { windowsContainer, macosContainer } = require('./container-utils');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const container = isWindows ? windowsContainer : macosContainer;

async function changeWorkspaceCommand(context) {
    if (!(await isInContainer())) {
        // If not in container, just show file browser
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select New Workspace Folder'
        });

        if (result && result[0]) {
            await vscode.commands.executeCommand('vscode.openFolder', result[0], { forceReuseWindow: true });
        }
        return;
    }

    try {
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: currentFolder.uri,
            title: 'Select New Workspace Folder'
        });

        if (!result || !result[0]) {
            log('No folder selected');
            return;
        }

        const newPath = result[0].fsPath.replace(/\\/g, '/');
        log(`Selected new workspace path: ${newPath}`);

        // Convert paths
        const containerPath = newPath;
        const wslPath = isWindows ?
            containerPath.replace('/home/jovyan', `/home/${await getWSLUsername()}`) :
            containerPath.replace('/home/jovyan', os.homedir());

        const projectName = getProjectName(containerPath);
        const workspaceFile = path.join(wslPath, `${projectName}.code-workspace`);
        const devContainerFile = path.join(wslPath, '.devcontainer.json');
        let tempDevContainerFile = null;

        log(`Container path: ${containerPath}`);
        log(`WSL path for writing: ${wslPath}`);
        log(`Checking for config files:
            Workspace: ${workspaceFile}
            DevContainer: ${devContainerFile}`);

        // Check if config files exist
        const [workspaceExists, devContainerExists] = await Promise.all([
            fs.promises.access(workspaceFile).then(() => true).catch(() => false),
            fs.promises.access(devContainerFile).then(() => true).catch(() => false)
        ]);

        log(`Config files exist check:
            Workspace: ${workspaceExists}
            DevContainer: ${devContainerExists}`);

        // If both config files exist, check for conflicts
        if (workspaceExists && devContainerExists) {
            log('Found existing configuration files, checking for conflicts');
            const stopped = await stopContainerIfNeeded(currentFolder.uri.fsPath, wslPath);
            if (!stopped) {
                log('User cancelled container stop, aborting workspace change');
                return;
            }
        } else {
            // Create a temporary .devcontainer.json to prevent VS Code from prompting
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            const devcontainerContent = await createDevcontainerContent(containerPath, wslComposeFile, isArm);

            log('Creating temporary .devcontainer.json to prevent prompt');
            tempDevContainerFile = await createTemporaryDevContainer(devcontainerContent, wslPath);

            // If we're already in a "latest" container, we can just switch
            const { stdout: currentContainer } = await execAsync('docker ps --format "{{.Names}}" --filter status=running --filter name=rsm-msba-k8s-latest');
            if (currentContainer.trim()) {
                log('Currently in latest container, proceeding with switch');
                const uri = await container.openInContainer(wslPath);
                log(`Opening with URI: ${uri.toString()}`);
                await openWorkspaceFolder(uri);
                return;
            }
        }

        // Get the container URI and open the folder
        const uri = await container.openInContainer(wslPath);
        log(`Opening with URI: ${uri.toString()}`);

        // If both config files exist, use them
        if (workspaceExists && devContainerExists) {
            log('Using existing configuration files');
            await openWorkspaceFolder(uri, workspaceFile);
        } else {
            // Create a temporary .devcontainer.json to prevent VS Code from prompting
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            const devcontainerContent = await createDevcontainerContent(containerPath, wslComposeFile, isArm);

            log('Creating temporary .devcontainer.json to prevent prompt');
            tempDevContainerFile = await createTemporaryDevContainer(devcontainerContent, wslPath);

            log('Opening folder directly in current container');
            await openWorkspaceFolder(uri);

            // Schedule cleanup
            if (tempDevContainerFile) {
                setTimeout(async () => {
                    try {
                        await cleanupTemporaryDevContainer(tempDevContainerFile, wslPath);
                    } catch (e) {
                        log(`Error cleaning up temporary devcontainer: ${e.message}`);
                    }
                }, 10000);
            }
        }

        // Wait a moment for the container to connect
        await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
        log(`Error in changeWorkspaceCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
    }
}

module.exports = {
    changeWorkspaceCommand
}; 