const vscode = require('vscode');
const { isWindows } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { createConfigFiles } = require('./file-utils');
const { isInContainer } = require('./container-utils');
const { openWorkspaceFolder } = require('./workspace-utils');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

async function startContainerCommand(context) {
    if (await isInContainer()) {
        const msg = 'Already connected to the RSM container';
        log(msg);
        vscode.window.showInformationMessage(msg);
        return;
    }

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        const msg = isWindows ?
            'Please open a folder in WSL2 first (File > Open Folder... and select a folder starting with \\\\wsl.localhost\\)' :
            'Please open a folder first (File > Open Folder...)';
        log(msg);
        vscode.window.showErrorMessage(msg);
        return;
    }

    const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    log(`Current path: ${currentPath}`);

    if (!paths.isWSLPath(currentPath) && isWindows) {
        const msg = 'Please select a folder in the WSL2 filesystem (\\\\wsl.localhost\\...)';
        log(msg);
        vscode.window.showErrorMessage(msg);
        return;
    }

    try {
        const devcontainerJsonPath = path.join(currentPath, '.devcontainer.json');
        log(`Checking for .devcontainer.json at: ${devcontainerJsonPath}`);

        let devcontainerContent;
        try {
            const devcontainerRaw = await fs.readFile(devcontainerJsonPath, 'utf8');
            devcontainerContent = JSON.parse(devcontainerRaw);
            log('Found existing .devcontainer.json');

            // Check if it's an RSM container
            if (devcontainerContent.name && devcontainerContent.name.startsWith('rsm-msba-k8s-')) {
                log(`Found RSM container configuration: ${devcontainerContent.name}`);

                // Check for running containers that might conflict
                const { stdout: containerList } = await execAsync('docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"');
                const runningContainers = containerList.split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                        const [name, image, ...statusParts] = line.split('\t');
                        return { name, image, status: statusParts.join('\t') };
                    })
                    .filter(c => c.name.startsWith('rsm-msba-k8s-') || c.image.includes('vnijs/rsm-msba-k8s'));

                log('Running k8s containers:');
                log(JSON.stringify(runningContainers, null, 2));

                // Get version suffix of target container
                const targetVersion = devcontainerContent.name.split('rsm-msba-k8s-')[1];
                log(`Target version: ${targetVersion}`);

                // Check for conflicts
                const conflictingContainers = runningContainers.filter(c => {
                    const containerVersion = c.name.split('rsm-msba-k8s-')[1];
                    return containerVersion !== targetVersion;
                });

                if (conflictingContainers.length > 0) {
                    log(`Found conflicting containers: ${JSON.stringify(conflictingContainers)}`);
                    const response = await vscode.window.showWarningMessage(
                        `A container with a different version (${conflictingContainers[0].name}) is already running. Would you like to stop it?`,
                        'Yes, Stop Container',
                        'No, Cancel'
                    );

                    if (response === 'Yes, Stop Container') {
                        for (const container of conflictingContainers) {
                            log(`Stopping container: ${container.name}`);
                            await execAsync(`docker stop ${container.name}`);
                        }
                    } else {
                        log('User cancelled due to container conflict');
                        return;
                    }
                }

                // Check for existing container with same name
                const sameNameContainers = runningContainers.filter(c => c.name === devcontainerContent.name);
                if (sameNameContainers.length > 0) {
                    log(`Found existing container: ${JSON.stringify(sameNameContainers[0])}`);
                    const container = sameNameContainers[0];

                    // If container exists but is not running, start it
                    if (!container.status.includes('Up')) {
                        log(`Starting existing container ${container.name}`);
                        await execAsync(`docker start ${container.name}`);
                        // Wait for container to be ready
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
        } catch (e) {
            log(`No valid .devcontainer.json found: ${e.message}`);
            log('Creating new configuration files');
            await createConfigFiles(currentPath);
        }

        // Get the container URI and open the folder
        const uri = vscode.Uri.parse(`vscode-remote://attached-container+${currentPath}`);
        log(`Opening with URI: ${uri.toString()}`);
        await openWorkspaceFolder(uri);

    } catch (error) {
        log('Error attaching to container:', true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to attach to container: ${error.message}`);
    }
}

module.exports = {
    startContainerCommand
}; 