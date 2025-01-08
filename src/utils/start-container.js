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
const os = require('os');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const { windowsContainer, macosContainer } = require('./container-utils');
const container = isWindows ? windowsContainer : macosContainer;

async function waitForContainer(maxWaitTimeMs = 30000, checkIntervalMs = 1000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTimeMs) {
        if (await isInContainer()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
    return false;
}

async function startContainerCommand(context, useTemporaryDevcontainer = true) {
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
        log(`Using devcontainer.json at: ${devcontainerJsonPath}`);

        let devcontainerContent;
        try {
            const devcontainerRaw = await fs.readFile(devcontainerJsonPath, 'utf8');
            devcontainerContent = JSON.parse(devcontainerRaw);
            log('Found existing .devcontainer.json');

            // If using temporary mode and this is not a temporary file, create a new one
            if (useTemporaryDevcontainer && !devcontainerContent.metadata?.isTemporary) {
                log('Creating new temporary configuration');
                await createConfigFiles(currentPath, useTemporaryDevcontainer);
                // Re-read the new configuration
                const newDevcontainerRaw = await fs.readFile(devcontainerJsonPath, 'utf8');
                devcontainerContent = JSON.parse(newDevcontainerRaw);
            }

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
            // Create config files in the temporary directory if using temporary mode
            await createConfigFiles(useTemporaryDevcontainer ? tmpDir : currentPath);
        }

        // Get the container URI and open the folder
        log(`The current path is: ${currentPath}`);
        // const uri = vscode.Uri.parse(`vscode-remote://attached-container+${currentPath}`);

        // const formattedPath = currentPath.replace(/\\+/g, '/');
        // const uri = await container.openInContainer(currentPath);
        const wslPath = paths.toWSLPath(currentPath);
        log(`wslPath: ${wslPath}`);
        const uri = await container.openInContainer(wslPath);
        log(`Opening with URI: ${uri}`);
        log(`Opening with URI: ${uri.toString()}`);

        // If using temporary mode, add cleanup command
        const afterCommands = useTemporaryDevcontainer ? [
            async () => {
                try {
                    await fs.unlink(devcontainerJsonPath);
                    log('Cleaned up .devcontainer.json file');
                } catch (error) {
                    log(`Error cleaning up .devcontainer.json: ${error.message}`);
                }
            }
        ] : [];

        await openWorkspaceFolder(uri, null, true, afterCommands);

    } catch (error) {
        log('Error attaching to container:', true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to attach to container: ${error.message}`);
    }
}

module.exports = {
    startContainerCommand
};