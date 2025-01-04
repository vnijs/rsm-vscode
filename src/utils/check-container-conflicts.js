const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const { isWindows, windowsContainer, macosContainer } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { createDevcontainerContent } = require('./file-utils');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const container = isWindows ? windowsContainer : macosContainer;

async function checkContainerConflictsCommand(context) {
    try {
        log('Starting checkContainerConflictsCommand');
        log(`Context received: ${context ? 'yes' : 'no'}`);

        // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        log(`Current folder: ${currentFolder ? currentFolder.uri.fsPath : 'none'}`);

        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        const folderPath = currentFolder.uri.fsPath;
        const devContainerFile = path.join(folderPath, '.devcontainer.json');
        log(`Looking for devcontainer file at: ${devContainerFile}`);

        // Get or create devcontainer content
        let containerName;
        try {
            const devContainerRaw = await fs.promises.readFile(devContainerFile, 'utf8');
            const devContainerContent = JSON.parse(devContainerRaw);
            containerName = devContainerContent.name;
            log(`Found container name in .devcontainer.json: ${containerName}`);
        } catch (e) {
            log(`Error reading .devcontainer.json: ${e.message}`);
            log('No .devcontainer.json found, creating default configuration');
            const isArm = os.arch() === 'arm64';
            log(`Architecture is ARM: ${isArm}`);
            const composeFile = container.getComposeFile(isArm, context);
            log(`Compose file path: ${composeFile}`);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            log(`WSL compose file path: ${wslComposeFile}`);
            const devContainerContent = await createDevcontainerContent(folderPath, wslComposeFile, isArm);
            containerName = devContainerContent.name;
            log(`Created default container name: ${containerName}`);
        }

        // Check for running containers only
        log('Checking for running containers...');
        const { stdout: containerList } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}"');
        log(`Docker ps output: ${containerList}`);

        // Parse running containers with their status
        const runningContainers = containerList.split('\n')
            .filter(line => line.trim())  // Filter out empty lines
            .map(line => {
                const [name, ...statusParts] = line.split('\t');
                return { name, status: statusParts.join('\t') };
            })
            .filter(c => c.name.startsWith('rsm-msba-k8s-')); // Only consider k8s containers

        log('Running k8s containers:');
        log(JSON.stringify(runningContainers, null, 2));

        // Get version suffix of target container (e.g., "latest" or "1.0.0")
        const targetVersion = containerName.split('rsm-msba-k8s-')[1];
        log(`Target version: ${targetVersion}`);

        // If the container we want is already running, that's fine!
        const targetIsRunning = runningContainers.some(c => c.name === containerName);
        if (targetIsRunning) {
            const msg = `Container ${containerName} is already running`;
            log(msg);
            vscode.window.showInformationMessage(msg);
            return true;
        }

        // Check for conflicts with other running k8s containers
        const conflicts = runningContainers.filter(c => {
            const version = c.name.split('rsm-msba-k8s-')[1];
            return version !== targetVersion;
        });
        log(`Found ${conflicts.length} potential conflicts`);

        if (conflicts.length > 0) {
            const msg = `Container conflict detected!\n\nTrying to create/attach: ${containerName}\nRunning containers with similar name:\n${conflicts.map(c => `- ${c.name} (${c.status})`).join('\n')}`;
            log(msg);

            // Ask user if they want to stop conflicting containers
            const stopButton = 'Stop Conflicting Container(s)';
            const response = await vscode.window.showWarningMessage(
                msg,
                { modal: true },
                stopButton
            );

            if (response === stopButton) {
                log('User chose to stop conflicting containers');
                for (const container of conflicts) {
                    try {
                        log(`Stopping container: ${container.name}`);
                        await execAsync(`docker stop ${container.name}`);
                        log(`Successfully stopped container: ${container.name}`);
                    } catch (error) {
                        log(`Error stopping container ${container.name}: ${error.message}`);
                        throw new Error(`Failed to stop container ${container.name}: ${error.message}`);
                    }
                }
                vscode.window.showInformationMessage(`Successfully stopped conflicting container(s). You can now proceed with attaching to ${containerName}`);
                return true; // Indicate successful resolution
            } else {
                log('User cancelled container conflict resolution');
                vscode.window.showInformationMessage('Operation cancelled. Conflicting containers are still running.');
                return false; // Indicate user cancelled
            }
        } else {
            const msg = 'No running containers found that would conflict. Safe to create new container.';
            log(msg);
            vscode.window.showInformationMessage(msg);
            return true; // No conflicts to resolve
        }
    } catch (error) {
        log(`Error in checkContainerConflictsCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to check container conflicts: ${error.message}`);
        return false; // Indicate error occurred
    }
}

module.exports = {
    checkContainerConflictsCommand
}; 