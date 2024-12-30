const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { isWindows, isMacOS, isInContainer, windowsContainer, macosContainer } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { writeFile, getProjectName } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const fs = require('fs');

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

        // Check for existing files and their metadata
        const devcontainerJsonPath = `${wslPath}/.devcontainer.json`;
        const workspaceFilePath = `${wslPath}/${projectName}.code-workspace`;
        let useExistingFiles = false;

        try {
            // Check if both files exist
            await vscode.workspace.fs.stat(vscode.Uri.file(devcontainerJsonPath));
            await vscode.workspace.fs.stat(vscode.Uri.file(workspaceFilePath));

            // Read workspace file to check metadata
            const workspaceContent = JSON.parse(fs.readFileSync(workspaceFilePath, 'utf8'));
            if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                useExistingFiles = true;
                log('Found existing files created by RSM extension');
            }
        } catch (e) {
            log('No existing files or metadata found');
        }

        if (useExistingFiles) {
            // Use existing configuration
            log('Using existing configuration files');
                const uri = await container.openInContainer(wslPath);
                log(`Opening with URI: ${uri.toString()}`);
                await vscode.commands.executeCommand('remote-containers.openFolder', uri);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return;
        }

        // If we get here, we need to create new configuration files
        const isArm = os.arch() === 'arm64';
        const composeFile = container.getComposeFile(isArm, context);
        const wslComposeFile = paths.toWSLMountPath(composeFile);
        log(`Using compose file: ${wslComposeFile}`);

        const devcontainerContent = {
            "name": isArm ? "rsm-msba-arm" : "rsm-msba-intel",
            "dockerComposeFile": [wslComposeFile],
            "service": "rsm-msba",
            "workspaceFolder": containerPath,
            "remoteUser": "jovyan",
            "overrideCommand": false,
            "remoteWorkspaceFolder": containerPath,
            "customizations": {
                "vscode": {
                    "extensions": ["ms-vscode-remote.remote-containers"],
                    "settings": {
                        "workbench.welcomePage.walkthroughs.openOnInstall": false,
                        "workbench.startupEditor": "none"
                    }
                }
            },
            "remoteEnv": {
                "HOME": "/home/jovyan"
            }
        };

        const workspaceContent = {
            "folders": [{ "path": "." }],
            "settings": {
                "remote.containers.defaultExtensions": [
                    "ms-vscode-remote.remote-containers"
                ],
                "workspace.openFolderWhenFileOpens": true,
                "remote.autoForwardPorts": true,
                "workbench.confirmBeforeOpen": false,
                "workbench.welcomePage.walkthroughs.openOnInstall": false
            },
            "extensions": {
                "recommendations": [
                    "ms-vscode-remote.remote-containers"
                ]
            },
            "metadata": {
                "createdBy": "rsm-vscode-extension",
                "createdAt": new Date().toLocaleString('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'),
                "containerVersion": "latest"
            }
        };

        log(`Creating .devcontainer.json at: ${devcontainerJsonPath}`);
        await writeFile(devcontainerContent, devcontainerJsonPath);
        
        log(`Creating workspace file at: ${workspaceFilePath}`);
        await writeFile(workspaceContent, workspaceFilePath);
        
        log(`Opening folder in container: ${containerPath}`);

        const uri = await container.openInContainer(wslPath);
        log(`Opening with URI: ${uri.toString()}`);
        
        await vscode.commands.executeCommand('remote-containers.openFolder', uri);

        // Wait a moment for the container to connect
        await new Promise(resolve => setTimeout(resolve, 2000));
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

        if (result && result[0]) {
            const newPath = result[0].fsPath.replace(/\\/g, '/');
            log(`Selected new workspace path: ${newPath}`);

            const containerPath = newPath;
            const wslPath = isWindows ? containerPath.replace('/home/jovyan', `/home/${await getWSLUsername()}`) : containerPath;

            const projectName = getProjectName(containerPath);
            
            log(`Container path: ${containerPath}`);
            log(`WSL path for writing: ${wslPath}`);

            // Check for existing files and their metadata
            const devcontainerJsonPath = `${wslPath}/.devcontainer.json`;
            const workspaceFilePath = `${wslPath}/${projectName}.code-workspace`;
            let useExistingFiles = false;

            try {
                // Check if both files exist
                await vscode.workspace.fs.stat(vscode.Uri.file(devcontainerJsonPath));
                await vscode.workspace.fs.stat(vscode.Uri.file(workspaceFilePath));

                // Read workspace file to check metadata
                const workspaceContent = JSON.parse(fs.readFileSync(workspaceFilePath, 'utf8'));
                if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                    useExistingFiles = true;
                    log('Found existing files created by RSM extension');
                }
            } catch (e) {
                log('No existing files or metadata found');
            }

            if (useExistingFiles) {
                // Use existing configuration
                log('Using existing configuration files');
                if (isMacOS) {
                    log('Using macOS-specific workspace opening');
                    await vscode.commands.executeCommand(
                        'remote-containers.openWorkspace',
                        vscode.Uri.file(workspaceFilePath)
                    );
                } else {
                    log('Using default workspace opening');
                    await vscode.commands.executeCommand(
                        'vscode.openFolder',
                        result[0],
                        { forceReuseWindow: true }
                    );
                }
                return;
            }

            // If we get here, we need to create new configuration files
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            log(`Using compose file: ${wslComposeFile}`);

            const devcontainerContent = {
                "name": isArm ? "rsm-msba-arm" : "rsm-msba-intel",
                "dockerComposeFile": [wslComposeFile],
                "service": "rsm-msba",
                "workspaceFolder": containerPath,
                "remoteUser": "jovyan",
                "overrideCommand": false,
                "remoteWorkspaceFolder": containerPath,
                "customizations": {
                    "vscode": {
                        "extensions": ["ms-vscode-remote.remote-containers"],
                        "settings": {
                            "workbench.welcomePage.walkthroughs.openOnInstall": false,
                            "workbench.startupEditor": "none"
                        }
                    }
                },
                "remoteEnv": {
                    "HOME": "/home/jovyan"
                }
            };

            const workspaceContent = {
                "folders": [{ "path": "." }],
                "settings": {
                    "remote.containers.defaultExtensions": [
                        "ms-vscode-remote.remote-containers"
                    ],
                    "workspace.openFolderWhenFileOpens": true,
                    "remote.autoForwardPorts": true,
                    "workbench.confirmBeforeOpen": false,
                    "workbench.welcomePage.walkthroughs.openOnInstall": false
                },
                "extensions": {
                    "recommendations": [
                        "ms-vscode-remote.remote-containers"
                    ]
                },
                "metadata": {
                    "createdBy": "rsm-vscode-extension",
                    "createdAt": new Date().toLocaleString('en-US', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'),
                    "containerVersion": "latest"
                }
            };

            log(`Creating .devcontainer.json at: ${devcontainerJsonPath}`);
            await writeFile(devcontainerContent, devcontainerJsonPath);
            
            log(`Creating workspace file at: ${workspaceFilePath}`);
            await writeFile(workspaceContent, workspaceFilePath);

            if (isMacOS) {
                log('Using macOS-specific workspace opening');
                await vscode.commands.executeCommand(
                    'remote-containers.openWorkspace',
                    vscode.Uri.file(workspaceFilePath)
                );
            } else {
                log('Using default workspace opening');
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    result[0],
                    { forceReuseWindow: true }
                );
            }

            log(`Workspace changed to: ${containerPath}`);
        } else {
            log('No workspace folder selected');
            vscode.window.showErrorMessage('Workspace change cancelled: No folder selected');
        }
    } catch (error) {
        log(`Error during workspace change: ${error.message}`);
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

async function setContainerVersionCommand(context) {
    if (!await isInContainer()) {
        const msg = 'Please connect to the RSM container first';
        log(msg);
        vscode.window.showErrorMessage(msg);
        return;
    }

    const version = await getContainerVersion();
    if (!version) {
        const msg = 'Could not determine container version';
        log(msg);
        vscode.window.showErrorMessage(msg);
        return;
    }

    log(`Container version detected: ${version}`);
    const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const wslPath = isWindows ? paths.toWSLPath(currentPath) : currentPath;
    const projectName = getProjectName(wslPath);

    // Copy docker-compose file
    const isArm = os.arch() === 'arm64';
    const sourceComposeFile = container.getComposeFile(isArm, context);
    const targetComposeFile = `${wslPath}/docker-compose.yml`;
    
    try {
        // Read and modify docker-compose content
        log('Reading source docker-compose file');
        let composeContent = fs.readFileSync(sourceComposeFile, 'utf8');
        composeContent = composeContent.replace(/latest/g, version);
        fs.writeFileSync(targetComposeFile, composeContent);
        log(`Created docker-compose.yml with version ${version}`);

        // Update .devcontainer.json to point to local docker-compose
        const devcontainerPath = `${wslPath}/.devcontainer.json`;
        log('Updating .devcontainer.json');
        const devcontainerContent = JSON.parse(fs.readFileSync(devcontainerPath, 'utf8'));
        devcontainerContent.dockerComposeFile = ['docker-compose.yml'];
        fs.writeFileSync(devcontainerPath, JSON.stringify(devcontainerContent, null, 2));
        log('Updated .devcontainer.json to use local docker-compose.yml');

        // Update .code-workspace file
        const workspaceFile = `${wslPath}/${projectName}.code-workspace`;
        log('Updating .code-workspace file');
        const workspaceContent = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
        if (workspaceContent.metadata) {
            workspaceContent.metadata.containerVersion = version;
            fs.writeFileSync(workspaceFile, JSON.stringify(workspaceContent, null, 2));
            log(`Updated .code-workspace with version ${version}`);
        }

        vscode.window.showInformationMessage(
            `Container version set to ${version}. Files updated: docker-compose.yml, .devcontainer.json, and .code-workspace`,
            'Rebuild Container'
        ).then(selection => {
            if (selection === 'Rebuild Container') {
                vscode.commands.executeCommand('remote-containers.rebuildContainer');
            }
        });
    } catch (error) {
        const msg = `Failed to update files: ${error.message}`;
        log(msg);
        vscode.window.showErrorMessage(msg);
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
    setContainerVersionCommand
}; 