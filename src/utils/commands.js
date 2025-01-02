const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { isWindows, isMacOS, isInContainer, windowsContainer, macosContainer, handleContainerConflict } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { writeFile, getProjectName, createDevcontainerContent, createWorkspaceContent, createTemporaryDevContainer, cleanupTemporaryDevContainer } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const { testFilePathsCommand } = require('./test-file-paths');
const { openWorkspaceFolder } = require('./workspace-utils');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { spawn } = require('child_process');
const { stopContainerIfNeeded } = require('./container-utils');
const { createConfigFiles } = require('./file-utils');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const container = isWindows ? windowsContainer : macosContainer;

// Store the pending workspace change
let pendingWorkspaceChange = null;

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
        // Check for container conflicts first
        const canProceed = await checkContainerConflictsCommand(context);
        if (!canProceed) {
            log('Container conflict check failed or was cancelled');
            return;
        }

        const wslPath = isWindows ? paths.toWSLPath(currentPath) : currentPath;
        const containerPath = paths.toContainerPath(currentPath);

        log(`Path for writing: ${wslPath}`);
        log(`Container path: ${containerPath}`);

        const projectName = getProjectName(containerPath);
        log(`Project name: ${projectName}`);

        // Check for existing files
        const devcontainerJsonPath = `${wslPath}/.devcontainer.json`;
        const workspaceFilePath = `${wslPath}/${projectName}.code-workspace`;
        const dockerComposePath = `${wslPath}/docker-compose.yml`;
        let useExistingFiles = false;
        let tempDevContainerFile = null;

        log('Checking paths:');
        log(`devcontainerJsonPath: ${devcontainerJsonPath}`);
        log(`workspaceFilePath: ${workspaceFilePath}`);
        log(`dockerComposePath: ${dockerComposePath}`);

        // Check if all required files exist and were created by our extension
        try {
            const [workspaceContent, devcontainerContent, dockerComposeContent] = await Promise.all([
                fs.promises.readFile(workspaceFilePath, 'utf8').catch(() => null),
                fs.promises.readFile(devcontainerJsonPath, 'utf8').catch(() => null),
                fs.promises.readFile(dockerComposePath, 'utf8').catch(() => null)
            ]);

            log('File read results:');
            log(`Workspace file exists: ${!!workspaceContent}`);
            log(`Devcontainer file exists: ${!!devcontainerContent}`);
            log(`Docker compose file exists: ${!!dockerComposeContent}`);

            if (workspaceContent && devcontainerContent && dockerComposeContent) {
                const workspaceJson = JSON.parse(workspaceContent);
                if (workspaceJson.metadata?.createdBy === 'rsm-vscode-extension') {
                    log('Found existing configuration created by RSM extension');
                    useExistingFiles = true;

                    // Check for existing container
                    const containerNameMatch = dockerComposeContent.match(/container_name:\s*([^\s]+)/);
                    if (containerNameMatch) {
                        const containerName = containerNameMatch[1];
                        log(`Found container name in docker-compose: ${containerName}`);

                        // Check if container exists (running or stopped)
                        const { stdout: containerList } = await execAsync('docker ps -a --format "{{.Names}} {{.Status}}"');
                        log(`Docker container list: ${containerList}`);

                        const containerExists = containerList.includes(containerName);
                        log(`Container ${containerName} exists: ${containerExists}`);

                        if (containerExists) {
                            const isRunning = containerList.includes(containerName + ' Up');
                            log(`Container ${containerName} is running: ${isRunning}`);

                            if (!isRunning) {
                                log(`Starting existing container ${containerName}`);
                                await execAsync(`docker start ${containerName}`);
                                await waitForContainer(containerName);
                            }
                        }
                    }

                    const version = workspaceJson.metadata.containerVersion || 'latest';
                    log(`Using existing configuration with version ${version}`);
                }
            }
        } catch (e) {
            log(`Error checking existing files: ${e.message}`);
            log(`Full error stack: ${e.stack}`);
        }

        if (!useExistingFiles) {
            // Create temporary .devcontainer.json for initial attach
            log('Creating temporary .devcontainer.json for initial attach');
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            const devcontainerContent = await createDevcontainerContent(containerPath, wslComposeFile, isArm);
            tempDevContainerFile = await createTemporaryDevContainer(devcontainerContent, wslPath);
            log(`Created temporary devcontainer file: ${tempDevContainerFile}`);
        }

        // Get the container URI and open the folder
        const uri = await container.openInContainer(wslPath);
        log(`Opening with URI: ${uri.toString()}`);
        await openWorkspaceFolder(uri, useExistingFiles ? workspaceFilePath : null);

        // Wait for container to connect
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Clean up temporary file if we created one
        if (tempDevContainerFile) {
            // Wait a bit longer before cleanup to ensure VS Code is done with the file
            setTimeout(async () => {
                try {
                    await cleanupTemporaryDevContainer(tempDevContainerFile, wslPath);
                    log('Cleaned up temporary devcontainer file');
                } catch (e) {
                    log(`Error cleaning up temporary devcontainer: ${e.message}`);
                }
            }, 10000);
        }
    } catch (error) {
        log('Error attaching to container:', true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to attach to container: ${error.message}`);
    }
}

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
            
            await container.stopContainer(context);
            vscode.window.showInformationMessage('Container stopped successfully');
        } else {
            throw new Error('No workspace folder found');
        }
    } catch (error) {
        log(`Failed to stop container: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
    }
}

async function startRadiantCommand() {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Attach to Container"');
        return;
    }

    try {
        const terminal = await vscode.window.createTerminal({
            name: 'Radiant',
            shellPath: '/bin/zsh'
        });
        
        terminal.show();
        terminal.sendText('/usr/local/bin/radiant');
    } catch (error) {
        log(`Failed to start Radiant: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to start Radiant: ${error.message}`);
    }
}

async function startGitGadgetCommand() {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Attach to Container"');
        return;
    }

    try {
        const terminal = await vscode.window.createTerminal({
            name: 'GitGadget',
            shellPath: '/bin/zsh'
        });
        
        terminal.show();
        terminal.sendText('/usr/local/bin/gitgadget');
    } catch (error) {
        log(`Failed to start GitGadget: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to start GitGadget: ${error.message}`);
    }
}

async function cleanPackagesCommand() {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Attach to Container"');
        return;
    }

    try {
        const terminal = await vscode.window.createTerminal({
            name: 'Clean Packages',
            shellPath: '/bin/zsh'
        });
        
        terminal.show();
        terminal.sendText('/usr/local/bin/clean');
    } catch (error) {
        log(`Failed to clean packages: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to clean packages: ${error.message}`);
    }
}

async function setupContainerCommand() {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Attach to Container"');
        return;
    }

    try {
        const terminal = await vscode.window.createTerminal({
            name: 'Setup Container',
            shellPath: '/bin/zsh'
        });
        
        terminal.show();
        terminal.sendText('/usr/local/bin/setup');
    } catch (error) {
        log(`Failed to setup container: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to setup container: ${error.message}`);
    }
}

async function debugEnvCommand() {
    const envInfo = {
        remoteName: vscode.env.remoteName,
        shell: vscode.env.shell,
        uiKind: vscode.env.uiKind,
        appHost: vscode.env.appHost,
        platform: process.platform,
        arch: os.arch(),
        inContainer: await isInContainer()
    };
    
    log('Environment Debug Info:');
    log(JSON.stringify(envInfo, null, 2));
    
    const message = `Remote name: ${envInfo.remoteName}\nIn container: ${envInfo.inContainer}`;
    vscode.window.showInformationMessage(message, 'Show Full Log').then(selection => {
        if (selection === 'Show Full Log') {
            vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        }
    });
}

async function getContainerVersion() {
    if (!(await isInContainer())) {
        return 'Unknown';
    }
    
    try {
        // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            log('No workspace folder found');
            return 'Unknown';
        }

        const terminal = await vscode.window.createTerminal({
            name: 'Version Check',
            shellPath: '/bin/zsh',
            hideFromUser: true
        });
        
        // Write to .rsm-version in the current workspace
        const versionFile = '.rsm-version';
        terminal.sendText(`printf "%s" "$DOCKERHUB_VERSION" > ${versionFile} && exit`);
        
        // Wait for the command to complete and file to be written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Read the version from the file using VS Code's API
        try {
            const uri = vscode.Uri.joinPath(currentFolder.uri, versionFile);
            const content = await vscode.workspace.fs.readFile(uri);
            const version = Buffer.from(content).toString().trim();
            
            // Clean up
            try { 
                await vscode.workspace.fs.delete(uri);
            } catch (e) { 
                /* ignore cleanup errors */ 
            }
            terminal.dispose();
            
            return version || 'Unknown';
        } catch (error) {
            log(`Failed to read version file: ${error.message}`);
            terminal.dispose();
            return 'Unknown';
        }
    } catch (error) {
        log(`Failed to get container version: ${error.message}`);
        return 'Unknown';
    }
}

async function readFileWSL(path) {
    try {
        const { stdout } = await execAsync(`wsl.exe bash -c 'cat "${path}"'`);
        return stdout;
    } catch (e) {
        throw new Error(`Failed to read file: ${e.message}`);
    }
}

// Add this helper function for cross-platform file reading
async function readFileContent(filePath) {
    if (isWindows) {
        return readFileWSL(filePath);
    } else {
        // Use direct file reading on macOS
        const fs = require('fs').promises;
        return fs.readFile(filePath, 'utf8');
    }
}

async function checkContainerReady(containerName) {
    try {
        const { stdout } = await execAsync('docker ps --format "{{.Names}} {{.Status}}"');
        const containers = stdout.split('\n');
        for (const container of containers) {
            if (container.includes(containerName) && container.includes('Up')) {
                return true;
            }
        }
        return false;
    } catch (error) {
        log(`Error checking container status: ${error.message}`);
        return false;
    }
}

async function waitForContainer(containerName, maxAttempts = 30) {
    log(`Waiting for container ${containerName} to be ready...`);
    for (let i = 0; i < maxAttempts; i++) {
        if (await checkContainerReady(containerName)) {
            log('Container is ready');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        log(`Waiting... attempt ${i + 1}/${maxAttempts}`);
    }
    log('Container did not become ready in time');
    return false;
}

async function setContainerVersionCommand(context) {
    try {
        // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        // Get current version and create options
        const currentVersion = await getContainerVersion();
        const versionOptions = ['latest'];
        if (currentVersion !== 'Unknown' && currentVersion !== 'latest') {
            versionOptions.push(currentVersion);
        }

        // Get version from user with current options
        const version = await vscode.window.showQuickPick(
            versionOptions,
            { placeHolder: 'Select container version' }
        );

        if (!version) {
            return; // User cancelled
        }

        log(`Setting container version to: ${version}`);

        // Get paths once and reuse
        const folderPath = currentFolder.uri.fsPath;
        const localPath = isWindows ?
            folderPath.replace('/home/jovyan', `/home/${await getWSLUsername()}`) :
            folderPath.replace('/home/jovyan', os.homedir());

        const projectName = getProjectName(folderPath);
        const workspaceFile = path.join(localPath, `${projectName}.code-workspace`);
        const devContainerFile = path.join(localPath, '.devcontainer.json');

        log(`Workspace file path: ${workspaceFile}`);
        let workspaceContent;

        // Get architecture once for reuse
        const isArm = os.arch() === 'arm64';
        const baseImageName = isArm ? 'vnijs/rsm-msba-k8s-arm' : 'vnijs/rsm-msba-k8s-intel';
        const containerName = version === 'latest' ? 'rsm-msba-k8s' : `rsm-msba-k8s-${version}`;

        // 1. Create or update workspace file
        try {
            const workspaceRaw = await fs.promises.readFile(workspaceFile, 'utf8');
            workspaceContent = JSON.parse(workspaceRaw);
            log('Successfully read existing .code-workspace');
        } catch (e) {
            log(`Workspace file not found or invalid, creating new one: ${e.message}`);
            workspaceContent = createWorkspaceContent();
        }

        // Ensure metadata exists and update version
        if (!workspaceContent.metadata) {
            workspaceContent.metadata = {
                createdBy: "rsm-vscode-extension",
                createdAt: new Date().toLocaleString('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
            };
        }
        workspaceContent.metadata.containerVersion = version;
        await writeFile(workspaceContent, workspaceFile);
        log(`Successfully updated .code-workspace with version ${version}`);

        // 2. Copy and modify docker-compose file
        const sourceComposeFile = container.getComposeFile(isArm, context);
        const targetComposeFile = path.join(localPath, 'docker-compose.yml');

        // Read source compose file
        const composeContent = await fs.promises.readFile(sourceComposeFile, 'utf8');
        let composeYaml = composeContent;

        // Update image and container name with version
        if (version !== 'latest') {
            composeYaml = composeContent
                .replace(`image: ${baseImageName}:latest`, `image: ${baseImageName}:${version}`)
                .replace(`container_name: rsm-msba-k8s-latest`, `container_name: ${containerName}`);
        }

        await fs.promises.writeFile(targetComposeFile, composeYaml);
        log(`Updated docker-compose.yml with version ${version}`);

        // 3. Update .devcontainer.json
        let devContainerContent;
        try {
            const devContainerRaw = await fs.promises.readFile(devContainerFile, 'utf8');
            devContainerContent = JSON.parse(devContainerRaw);
        } catch (e) {
            log(`Creating new .devcontainer.json`);
            devContainerContent = await createDevcontainerContent(folderPath, 'docker-compose.yml', isArm);
        }

        // Update container name with version
        devContainerContent.name = containerName;
        devContainerContent.dockerComposeFile = ['docker-compose.yml'];

        // Write the final .devcontainer.json
        await writeFile(devContainerContent, devContainerFile);
        log(`Updated .devcontainer.json with version ${version}`);

        vscode.window.showInformationMessage(
            `Configuration files updated for version ${version}. Use "RSM: Detach from Container" and then "RSM: Attach to Container" to switch to the new version.`
        );

    } catch (error) {
        const msg = `Failed to update files: ${error.message}`;
        log(msg);
        log(`Full error stack: ${error.stack}`);
        vscode.window.showErrorMessage(msg);
    }
}

// Add this to the activate function at the top level
async function handlePendingContainerAttach(context) {
    const pendingAttach = context.globalState.get('pendingContainerAttach');
    if (pendingAttach && (Date.now() - pendingAttach.timestamp < 30000)) {
        log('Found pending container attach, resuming...');
        const uri = await container.openInContainer(pendingAttach.path);
        await vscode.commands.executeCommand('remote-containers.openFolder', uri);
        // Clear the pending attach
        context.globalState.update('pendingContainerAttach', undefined);
    }
}

// Save current version with new name
async function changeWorkspaceCommandNew() {
    try {
        // Check if we're in a container first
        if (!(await isInContainer())) {
            log('Not connected to the RSM container');
            vscode.window.showErrorMessage('Not connected to the RSM container');
            return;
        }
        log('Container check passed');

        // Get the current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!currentFolder) {
            log('No current workspace folder found');
            return;
        }
        log(`Current workspace folder: ${currentFolder}`);

        // Show folder picker
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Folder to Open in Container'
        });

        if (!result || result.length === 0) {
            log('Workspace change cancelled: No folder selected');
            return;
        }

        const targetFolder = result[0].fsPath;
        log(`Selected folder: ${targetFolder}`);

        // Convert target folder to local path if needed
        const localTargetFolder = paths.toLocalPath(targetFolder);
        log(`Local target folder: ${localTargetFolder}`);

        // Get the container path
        const containerPath = `/home/jovyan/${path.basename(localTargetFolder)}`;
        log(`Container path: ${containerPath}`);

        // Stop current container if needed (different versions)
        await stopContainerIfNeeded(currentFolder, localTargetFolder);

        // Create workspace file if it doesn't exist
        const workspaceFile = path.join(localTargetFolder, path.basename(localTargetFolder) + '.code-workspace');
        const devContainerFile = path.join(localTargetFolder, '.devcontainer.json');

        log(`Will check for configuration files:
            Workspace file: ${workspaceFile}
            DevContainer file: ${devContainerFile}`);

        // Check if files exist
        const [workspaceExists, devContainerExists] = await Promise.all([
            fs.promises.access(workspaceFile).then(() => true).catch(() => false),
            fs.promises.access(devContainerFile).then(() => true).catch(() => false)
        ]);

        log(`File existence check results:
            Workspace file exists: ${workspaceExists}
            DevContainer file exists: ${devContainerExists}`);

        let useExistingFiles = workspaceExists && devContainerExists;
        log(`Using existing files: ${useExistingFiles}`);

        if (!useExistingFiles) {
            log('No existing configuration found. Creating new files...');
            await createConfigFiles(localTargetFolder);
            useExistingFiles = true;
        }

        // Get the container URI using the local target folder
        log(`Opening folder in container: ${localTargetFolder}`);
        const uri = await container.openInContainer(localTargetFolder);
        log(`Opening with URI: ${uri.toString()}`);

        // First open the folder in the container (without workspace file)
        await openWorkspaceFolder(uri, null);

        // Wait a moment for the container to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Then open the workspace file if it exists
        if (useExistingFiles) {
            log(`Opening workspace file: ${workspaceFile}`);
            await vscode.commands.executeCommand('remote-containers.openWorkspace', vscode.Uri.file(workspaceFile));
        }

    } catch (error) {
        log(`Error in changeWorkspaceCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
    }
}

async function changeWorkspaceCommand(context) {
    if (!(await isInContainer())) {
        vscode.window.showErrorMessage('Not connected to the RSM container');
        return;
    }

    try {
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        // If we have a pending change, process it
        if (pendingWorkspaceChange) {
            const targetPath = pendingWorkspaceChange;
            pendingWorkspaceChange = null; // Clear it immediately
            log(`Processing pending workspace change to: ${targetPath}`);

            // Get the container URI and open the folder
            const uri = await container.openInContainer(targetPath);
            log(`Opening with URI: ${uri.toString()}`);
            await openWorkspaceFolder(uri);
            return;
        }

        // Otherwise, handle new workspace selection
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

        // Check for container conflicts
        const targetDevContainerFile = path.join(newPath, '.devcontainer.json');
        let targetContainerName;
        try {
            const devContainerRaw = await fs.promises.readFile(targetDevContainerFile, 'utf8');
            const devContainerContent = JSON.parse(devContainerRaw);
            targetContainerName = devContainerContent.name;
            log(`Target container name: ${targetContainerName}`);
        } catch (e) {
            log(`No .devcontainer.json found in target, using default configuration`);
            const isArm = os.arch() === 'arm64';
            targetContainerName = isArm ? 'rsm-msba-k8s-arm-latest' : 'rsm-msba-k8s-intel-latest';
        }

        // Check for running containers
        const { stdout: containerList } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}"');
        const runningContainers = containerList.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [name, ...statusParts] = line.split('\t');
                return { name, status: statusParts.join('\t') };
            })
            .filter(c => c.name.startsWith('rsm-msba-k8s-'));

        // If target container is already running, that's fine
        const targetIsRunning = runningContainers.some(c => c.name === targetContainerName);
        if (targetIsRunning) {
            log(`Target container ${targetContainerName} is already running`);
            pendingWorkspaceChange = newPath;
            // Use our existing stop container command
            await stopContainerCommand(context);
            return;
        }

        // Check for conflicts
        const conflicts = runningContainers.filter(c => c.name !== targetContainerName);
        if (conflicts.length > 0) {
            const msg = `Container conflict detected!\n\nTrying to switch to: ${targetContainerName}\nCurrently running:\n${conflicts.map(c => `- ${c.name} (${c.status})`).join('\n')}`;
            log(msg);

            const detachAndStopButton = 'Detach, Stop Container, and Switch';
            const response = await vscode.window.showWarningMessage(
                msg,
                { modal: true, detail: 'This will detach from the current container and stop any conflicting containers.' },
                detachAndStopButton
            );

            if (response === detachAndStopButton) {
                log('User chose to detach and stop containers');
                pendingWorkspaceChange = newPath;

                // Store current workspace path before detaching
                await context.globalState.update('lastWorkspaceFolder', currentFolder.uri.fsPath);

                // Use our existing stop container command
                await stopContainerCommand(context);

                // Then stop any other conflicting containers
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
                return;
            } else {
                log('User cancelled workspace change due to conflicts');
                vscode.window.showInformationMessage('Workspace change cancelled. Conflicting containers are still running.');
                return;
            }
        }

        // No conflicts, proceed with change
        log('No conflicts found, proceeding with workspace change');
        pendingWorkspaceChange = newPath;
        await stopContainerCommand(context);

    } catch (error) {
        log(`Error in changeWorkspaceCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
    }
}

async function debugContainerCommand() {
    const terminal = await vscode.window.createTerminal({
        name: 'RSM Debug',
        shellPath: isWindows ? 'wsl.exe' : '/bin/zsh'
    });
    
    const containerChecks = {
        remoteName: vscode.env.remoteName,
        inContainer: await isInContainer(),
        platform: process.platform,
        arch: os.arch(),
        shell: isWindows ? 'wsl.exe' : '/bin/zsh',
        pwd: '',
        whoami: ''
    };

    try {
        if (isWindows) {
            terminal.sendText('bash -c "pwd && whoami && echo $SHELL"');
        } else {
            terminal.sendText('pwd && whoami && echo $SHELL');
        }
        
        terminal.show();
        
        log('Container Status Debug Info:');
        log(JSON.stringify(containerChecks, null, 2));
        
        vscode.window.showInformationMessage(
            'Container debug information shown in terminal',
            'Show Log'
        ).then(selection => {
            if (selection === 'Show Log') {
                vscode.commands.executeCommand('workbench.action.output.toggleOutput');
            }
        });
    } catch (error) {
        log(`Debug check failed: ${error.message}`);
        terminal.dispose();
    }
}

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
                stopButton,
                'Cancel'
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
};