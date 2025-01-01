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

    const wslPath = isWindows ? paths.toWSLPath(currentPath) : currentPath;
    const containerPath = paths.toContainerPath(currentPath);
    
    log(`Path for writing: ${wslPath}`);
    log(`Container path: ${containerPath}`);

    if (!paths.isWSLPath(currentPath) && isWindows) {
        const msg = 'Please select a folder in the WSL2 filesystem (\\\\wsl.localhost\\...)';
        log(msg);
        vscode.window.showErrorMessage(msg);
        return;
    }

    try {
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
                fs.promises.readFile(workspaceFilePath, 'utf8'),
                fs.promises.readFile(devcontainerJsonPath, 'utf8'),
                fs.promises.readFile(dockerComposePath, 'utf8')
            ]);

            const workspaceJson = JSON.parse(workspaceContent);
            if (workspaceJson.metadata?.createdBy === 'rsm-vscode-extension') {
                log('Found existing configuration created by RSM extension');
                useExistingFiles = true;
                const version = workspaceJson.metadata.containerVersion || 'latest';
                vscode.window.showInformationMessage(
                    `Found existing configuration with version ${version}. Using existing files.`
                );
            } else {
                log('Found workspace file but not created by RSM extension');
            }
        } catch (e) {
            log(`Could not read or validate configuration files: ${e.message}`);
        }

        if (!useExistingFiles) {
            // Create temporary .devcontainer.json for initial attach
            log('Creating temporary .devcontainer.json for initial attach');
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            const devcontainerContent = await createDevcontainerContent(containerPath, wslComposeFile, isArm);
            tempDevContainerFile = await createTemporaryDevContainer(devcontainerContent, wslPath);
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

        // Store path for reattachment after restart
        context.globalState.update('pendingContainerAttach', {
            path: localPath,
            timestamp: Date.now()
        });

        log(`Workspace file path: ${workspaceFile}`);
        let workspaceContent;

        // Get architecture once for reuse
        const isArm = os.arch() === 'arm64';
        const baseImageName = isArm ? 'vnijs/rsm-msba-k8s-arm' : 'vnijs/rsm-msba-k8s-intel';
        const baseContainerName = isArm ? 'rsm-msba-k8s-arm' : 'rsm-msba-k8s-intel';
        const containerName = version === 'latest' ? baseContainerName : `${baseContainerName}-${version}`;

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
                .replace(`container_name: ${baseContainerName}`, `container_name: ${containerName}`);
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
        const baseName = isArm ? 'rsm-msba-arm' : 'rsm-msba-intel';
        devContainerContent.name = version === 'latest' ? baseName : `${baseName}-${version}`;
        devContainerContent.dockerComposeFile = ['docker-compose.yml'];

        // Write the final .devcontainer.json
        await writeFile(devContainerContent, devContainerFile);
        log(`Updated .devcontainer.json with version ${version}`);

        // Now that all files are updated, handle container switch
        log('Managing container switch...');

        // Get all running containers with our base name
        const baseContainerPrefix = 'rsm-msba-k8s-arm';
        try {
            const { stdout: runningContainers } = await execAsync('docker ps --format "{{.Names}}"');
            log(`Currently running containers:\n${runningContainers}`);

            // Stop any containers with our base name
            const containersToStop = runningContainers.split('\n')
                .filter(name => name.startsWith(baseContainerPrefix));

            if (containersToStop.length > 0) {
                log(`Found containers to stop: ${containersToStop.join(', ')}`);
                for (const containerName of containersToStop) {
                    log(`Stopping container: ${containerName}`);
                    await execAsync(`docker stop ${containerName}`);
                    await execAsync(`docker rm ${containerName}`);
                }
            }
        } catch (error) {
            log(`Note during container cleanup: ${error.message}`);
        }

        // Now check if a container with our target name already exists
        const targetContainerName = version === 'latest' ? baseContainerName : `${baseContainerName}-${version}`;
        try {
            const { stdout: existingContainer } = await execAsync(`docker ps -q -f name=${targetContainerName}`);
            if (existingContainer) {
                log(`Container ${targetContainerName} already exists and running, will reuse it`);
                // Store path for reattachment after restart
                context.globalState.update('pendingContainerAttach', {
                    path: localPath,
                    timestamp: Date.now()
                });
                return;
            }
        } catch (error) {
            log(`Note checking existing container: ${error.message}`);
        }

        // Stop VS Code's connection to the container
        log('Stopping VS Code container connection...');
        await stopContainerCommand(context);
        log('VS Code container connection stopped');

        // Store path for reattachment after restart
        context.globalState.update('pendingContainerAttach', {
            path: localPath,
            timestamp: Date.now()
        });

        // The extension will restart here, and the activate function will handle reattachment

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

        // We're already in the container, so newPath is the containerPath
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

        // Only check for conflicts if we're going to use existing config files
        if (workspaceExists && devContainerExists) {
            log('Found existing configuration files, checking for conflicts');
            // Check for and stop any conflicting containers
            const stopped = await stopContainerIfNeeded(currentFolder.uri.fsPath, wslPath);
            if (!stopped) {
                log('User cancelled container stop, aborting workspace change');
                return;
            }
        } else {
            log('No existing configuration files found, will reuse current container');
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
    testFilePathsCommand
};