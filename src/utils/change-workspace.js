/**
 * @fileoverview Handles workspace switching in the RSM VS Code extension with container conflict detection and resolution.
 * 
 * Key Components:
 * 1. Pending Workspace Change: Stores path of workspace to switch to after resolving conflicts
 * 2. Container Conflict Detection: Checks and handles container conflicts during workspace switches
 * 3. Workspace Change Command: Main command for changing workspaces
 * 
 * Workflow Examples:
 * 1. Simple Workspace Switch:
 *    User selects new folder → No conflicts → Immediate switch
 * 
 * 2. Conflict Resolution Flow:
 *    User selects new folder 
 *    → Conflict detected 
 *    → User clicks "Detach and Stop" 
 *    → Current container detached 
 *    → Conflicting containers stopped 
 *    → Path stored as pending 
 *    → User runs command again 
 *    → Switches to pending folder
 * 
 * 3. Non-Container Workspace Switch:
 *    User not in container 
 *    → Shows file browser 
 *    → Direct folder switch
 */

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
const { windowsPaths, macosPaths } = require('./path-utils');
const { windowsContainer, macosContainer } = require('./container-utils');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const container = isWindows ? windowsContainer : macosContainer;

// Store pending workspace change
let pendingWorkspaceChange = null;

/**
 * Checks for and handles container conflicts when switching workspaces.
 * 
 * Process:
 * 1. Container Status Check:
 *    - Lists all running Docker containers
 *    - Filters for containers starting with 'rsm-msba-k8s-'
 *    - Extracts container names and status
 * 
 * 2. Conflict Detection Logic:
 *    - Gets version suffix from target container (e.g., "latest" or "1.0.0")
 *    - Checks if target container is already running
 *    - Identifies conflicts with other running containers with different versions
 * 
 * 3. Conflict Resolution:
 *    - If target container is running: Proceeds with switch
 *    - If conflicts found: Shows warning dialog with "Detach and Stop" option
 *    - If no conflicts: Allows immediate switch
 * 
 * @param {vscode.ExtensionContext} context - The extension context
 * @param {string} containerName - Name of the target container
 * @param {string} wslPath - The WSL path to switch to
 * @returns {Promise<boolean>} True if can proceed, false if conflicts or cancelled
 */
async function checkContainerConflicts(context, containerName, wslPath) {
    try {
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

            // Ask user if they want to detach and stop
            const detachButton = 'Detach and Stop';
            const response = await vscode.window.showWarningMessage(
                msg,
                { modal: true },
                detachButton
            );

            if (response === detachButton) {
                log('User chose to detach and stop');
                // Store the pending change first
                pendingWorkspaceChange = wslPath;

                // Then detach from current container
                const currentFolder = vscode.workspace.workspaceFolders?.[0];
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

                    // Wait for detach to complete
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Stop the conflicting containers
                    for (const container of conflicts) {
                        try {
                            log(`Stopping container: ${container.name}`);
                            await execAsync(`docker stop ${container.name}`);
                            log(`Successfully stopped container: ${container.name}`);
                        } catch (error) {
                            log(`Error stopping container ${container.name}: ${error.message}`);
                        }
                    }
                }

                vscode.window.showInformationMessage('Detached and stopped containers. Use "RSM: Change Workspace Folder" to switch to your desired folder.');
                return false; // Return false to prevent immediate switch
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
        log(`Error checking container conflicts: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to check container conflicts: ${error.message}`);
        return false; // Indicate error occurred
    }
}

/**
 * Main command for changing workspaces.
 * 
 * Process Flow:
 * 1. Initial State Check:
 *    - If not in container with pending change:
 *      * Attempts to switch to pending workspace
 *      * Clears pending change after switch
 *    - If not in container without pending change:
 *      * Shows file browser for folder selection
 *      * Opens selected folder directly
 * 
 * 2. Path Processing:
 *    - Converts selected path to container and WSL paths
 *    - Handles Windows/macOS path differences
 *    - Generates workspace and devcontainer file paths
 * 
 * 3. Configuration File Management:
 *    - Checks for existing workspace and devcontainer files
 *    - Creates temporary devcontainer file if needed
 *    - Gets container name from devcontainer file
 * 
 * 4. Container Conflict Handling:
 *    - Calls checkContainerConflicts with container name
 *    - If conflicts detected:
 *      * Stores pending workspace change
 *      * Returns without switching
 *    - If no conflicts:
 *      * Proceeds with workspace switch
 * 
 * 5. Workspace Switch:
 *    - Gets container URI
 *    - Opens folder in container
 *    - Waits for container connection
 *    - Cleans up temporary files
 * 
 * Error Handling:
 * - Logs all operations and errors
 * - Shows user-friendly error messages
 * - Gracefully handles file access errors
 * - Manages container operation failures
 * 
 * @param {vscode.ExtensionContext} context - The extension context
 * @returns {Promise<void>}
 */
async function changeWorkspaceCommand(context) {
    try {
        // Check if there's a pending change and we're not in a container
        if (!(await isInContainer()) && pendingWorkspaceChange) {
            log('Found pending workspace change, attempting to switch');
            const uri = await container.openInContainer(pendingWorkspaceChange);
            log(`Opening with URI: ${uri.toString()}`);
            await openWorkspaceFolder(uri);
            pendingWorkspaceChange = null;
            return;
        }

    // If not in container and no pending change, just show file browser
        if (!(await isInContainer())) {
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

        // Create temporary .devcontainer.json if needed
        if (!devContainerExists) {
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            const devcontainerContent = await createDevcontainerContent(containerPath, wslComposeFile, isArm);

            log('Creating temporary .devcontainer.json to prevent prompt');
            tempDevContainerFile = await createTemporaryDevContainer(devcontainerContent, wslPath);
        }

        // Get container name from devcontainer file
        let containerName;
        try {
            const devContainerRaw = await fs.promises.readFile(devContainerFile, 'utf8');
            const devContainerContent = JSON.parse(devContainerRaw);
            containerName = devContainerContent.name;
        } catch (e) {
            const isArm = os.arch() === 'arm64';
            const devcontainerContent = await createDevcontainerContent(containerPath, 'docker-compose.yml', isArm);
            containerName = devcontainerContent.name;
        }

        // Check for container conflicts
        const canProceed = await checkContainerConflicts(context, containerName, wslPath);
        if (!canProceed) {
            log('Container conflict detected, storing pending change');
            pendingWorkspaceChange = wslPath;
            return;
        }

        // Get the container URI and open the folder
        const uri = await container.openInContainer(wslPath);
        log(`Opening with URI: ${uri.toString()}`);
        await openWorkspaceFolder(uri);

        // Wait a moment for the container to connect
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Clean up temporary file if we created one
        if (tempDevContainerFile) {
            setTimeout(async () => {
                try {
                    await cleanupTemporaryDevContainer(tempDevContainerFile, wslPath);
                } catch (e) {
                    log(`Error cleaning up temporary devcontainer: ${e.message}`);
                }
            }, 10000);
        }

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