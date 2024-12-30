const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { isWindows, isMacOS, isInContainer, windowsContainer, macosContainer } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { writeFile, getProjectName } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const { testFilePathsCommand } = require('./test-file-paths');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { spawn } = require('child_process');

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
        const dockerComposePath = `${wslPath}/docker-compose.yml`;
        let useExistingFiles = false;

        log('Checking paths:');
        log(`devcontainerJsonPath: ${devcontainerJsonPath}`);
        log(`workspaceFilePath: ${workspaceFilePath}`);
        log(`dockerComposePath: ${dockerComposePath}`);

        // Try different methods to read the workspace file
        try {
            // Method 1: Direct WSL read
            log('Attempting to read workspace file using wsl.exe cat...');
            try {
                const workspaceRaw = await readFileWSL(workspaceFilePath);
                const workspaceContent = JSON.parse(workspaceRaw);
                log('Successfully read workspace file using wsl.exe cat');
                if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                    log('Found existing workspace file created by RSM extension');
                    // Check if there's a specific container version set
                    const containerVersion = workspaceContent.metadata?.containerVersion;
                    if (containerVersion && containerVersion !== 'latest') {
                        // Check if local docker-compose file exists
                        try {
                            const composeContent = await readFileWSL(dockerComposePath);
                            log('Found local docker-compose.yml file');
                            useExistingFiles = true;
                            vscode.window.showInformationMessage(
                                `Found existing configuration with version ${containerVersion}. Using existing files.`
                            );
                        } catch (e) {
                            log(`Failed to read docker-compose.yml: ${e.message}`);
                            vscode.window.showInformationMessage(
                                `Found configuration with version ${containerVersion} but no docker-compose.yml. Will create new files.`
                            );
                        }
                    } else {
                        useExistingFiles = true;
                        log('Found existing files created by RSM extension');
                        vscode.window.showInformationMessage(
                            'Found existing configuration with latest version. Using existing files.'
                        );
                    }
                } else {
                    log('Workspace file exists but was not created by RSM extension');
                    vscode.window.showInformationMessage(
                        'Found workspace file not created by RSM extension. Will create new files.'
                    );
                }
            } catch (e) {
                log(`Failed to read workspace file using wsl.exe cat: ${e.message}`);
                
                // Method 2: Try VS Code's file system API
                log('Attempting to read workspace file using VS Code API...');
                try {
                    const uri = vscode.Uri.file(workspaceFilePath);
                    const content = await vscode.workspace.fs.readFile(uri);
                    const workspaceContent = JSON.parse(content.toString());
                    log('Successfully read workspace file using VS Code API');
                    
                    if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                        // Same version checking logic as above
                        log('Found existing workspace file created by RSM extension');
                        const containerVersion = workspaceContent.metadata?.containerVersion;
                        if (containerVersion && containerVersion !== 'latest') {
                            try {
                                await vscode.workspace.fs.stat(vscode.Uri.file(dockerComposePath));
                                log('Found local docker-compose.yml file');
                                useExistingFiles = true;
                                vscode.window.showInformationMessage(
                                    `Found existing configuration with version ${containerVersion}. Using existing files.`
                                );
                            } catch (e) {
                                log(`Failed to find docker-compose.yml: ${e.message}`);
                                vscode.window.showInformationMessage(
                                    `Found configuration with version ${containerVersion} but no docker-compose.yml. Will create new files.`
                                );
                            }
                        } else {
                            useExistingFiles = true;
                            log('Found existing files created by RSM extension');
                            vscode.window.showInformationMessage(
                                'Found existing configuration with latest version. Using existing files.'
                            );
                        }
                    }
                } catch (e2) {
                    log(`Failed to read workspace file using VS Code API: ${e2.message}`);
                    log('No existing workspace file found or unable to read it');
                    vscode.window.showInformationMessage(
                        'No existing configuration found. Will create new files.'
                    );
                }
            }
        } catch (e) {
            log(`All file reading attempts failed: ${e.message}`);
            vscode.window.showInformationMessage(
                'No existing configuration found. Will create new files.'
            );
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

async function readFileWSL(path) {
    try {
        const { stdout } = await execAsync(`wsl.exe bash -c 'cat "${path}"'`);
        return stdout;
    } catch (e) {
        throw new Error(`Failed to read file: ${e.message}`);
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
    log(`Current path: ${currentPath}`);

    // Get WSL username for correct path
    const wslUsername = await getWSLUsername();
    log(`WSL username: ${wslUsername}`);

    // Convert container path to WSL path
    const wslPath = currentPath.replace(/\\/g, '/').replace('/home/jovyan', `/home/${wslUsername}`);
    log(`WSL path: ${wslPath}`);

    const projectName = getProjectName(wslPath);
    log(`Project name: ${projectName}`);

    // Check existing files first
    const workspaceFile = `${wslPath}/${projectName}.code-workspace`;
    let shouldUpdate = true;
    let existingVersion = null;

    try {
        // Check if workspace file exists and was created by our extension
        const workspaceRaw = await readFileWSL(workspaceFile);
        const workspaceContent = JSON.parse(workspaceRaw);
        
        if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
            log('Found existing workspace file created by RSM extension');
            existingVersion = workspaceContent.metadata?.containerVersion;
            
            if (existingVersion && existingVersion !== 'latest') {
                log(`Existing version found: ${existingVersion}`);
                shouldUpdate = false;
                vscode.window.showInformationMessage(
                    `Found existing configuration with version ${existingVersion}. Will not overwrite files.`
                );
                return;
            } else {
                log('No specific version found in existing workspace file');
                vscode.window.showInformationMessage(
                    'Found existing configuration but no specific version set. Will update files.'
                );
            }
        } else {
            log('Workspace file exists but was not created by RSM extension');
            vscode.window.showInformationMessage(
                'Found workspace file not created by RSM extension. Will update files.'
            );
        }
    } catch (e) {
        log('No existing workspace file found or error reading it');
        vscode.window.showInformationMessage(
            'No existing configuration found. Will create new files.'
        );
    }

    if (!shouldUpdate) {
        return;
    }

    // Copy docker-compose file
    const isArm = os.arch() === 'arm64';
    const sourceComposeFile = container.getComposeFile(isArm, context);
    log(`Source compose file: ${sourceComposeFile}`);

    try {
        // Read and modify docker-compose content
        log(`Reading source docker-compose file from: ${sourceComposeFile}`);
        let composeContent = fs.readFileSync(sourceComposeFile, 'utf8')
            .replace(/\r\n/g, '\n'); // Normalize line endings
        log('Successfully read source docker-compose file');
        
        // Replace all instances of "latest" with the version
        composeContent = composeContent.replace(/latest/g, version);
        
        // Add version to container name with hyphen
        composeContent = composeContent.replace(
            /(container_name:\s*"?rsm-msba-k8s-arm)"?/g,
            `$1-${version}`
        );
        
        // Write files using WSL paths
        const targetComposeFile = `${wslPath}/docker-compose.yml`;
        log(`Writing docker-compose.yml to: ${targetComposeFile}`);
        const proc = spawn('wsl.exe', ['bash', '-c', `cat > "${targetComposeFile}"`]);
        proc.stdin.write(composeContent);
        proc.stdin.end();
        
        await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to write docker-compose.yml, exit code: ${code}`));
                }
            });
        });
        log(`Successfully created docker-compose.yml with version ${version}`);

        // Update .devcontainer.json
        const devcontainerPath = `${wslPath}/.devcontainer.json`;
        log(`Reading .devcontainer.json from: ${devcontainerPath}`);
        let devcontainerContent;
        try {
            const devcontainerRaw = await readFileWSL(devcontainerPath);
            devcontainerContent = JSON.parse(devcontainerRaw);
            log('Successfully read .devcontainer.json');
        } catch (e) {
            log(`Error reading .devcontainer.json: ${e.message}`);
            throw new Error('Failed to read .devcontainer.json');
        }
        devcontainerContent.dockerComposeFile = ['docker-compose.yml'];
        await writeFile(devcontainerContent, devcontainerPath);
        log('Successfully updated .devcontainer.json to use local docker-compose.yml');

        // Update .code-workspace file
        log(`Reading .code-workspace from: ${workspaceFile}`);
        let workspaceContent;
        try {
            const workspaceRaw = await readFileWSL(workspaceFile);
            workspaceContent = JSON.parse(workspaceRaw);
            log('Successfully read .code-workspace');
        } catch (e) {
            log(`Error reading workspace file: ${e.message}`);
            throw new Error('Failed to read workspace file');
        }
        workspaceContent.metadata.containerVersion = version;
        await writeFile(workspaceContent, workspaceFile);
        log(`Successfully updated .code-workspace with version ${version}`);

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
        log(`Full error stack: ${error.stack}`);
        vscode.window.showErrorMessage(msg);
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
            const dockerComposePath = `${wslPath}/docker-compose.yml`;
            let useExistingFiles = false;

            log('Checking paths:');
            log(`devcontainerJsonPath: ${devcontainerJsonPath}`);
            log(`workspaceFilePath: ${workspaceFilePath}`);
            log(`dockerComposePath: ${dockerComposePath}`);

            // Try different methods to read the workspace file
            try {
                // Method 1: Direct WSL read
                log('Attempting to read workspace file using wsl.exe cat...');
                try {
                    const workspaceRaw = await readFileWSL(workspaceFilePath);
                    const workspaceContent = JSON.parse(workspaceRaw);
                    log('Successfully read workspace file using wsl.exe cat');
                    if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                        log('Found existing workspace file created by RSM extension');
                        // Check if there's a specific container version set
                        const containerVersion = workspaceContent.metadata?.containerVersion;
                        if (containerVersion && containerVersion !== 'latest') {
                            // Check if local docker-compose file exists
                            try {
                                const composeContent = await readFileWSL(dockerComposePath);
                                log('Found local docker-compose.yml file');
                                useExistingFiles = true;
                                vscode.window.showInformationMessage(
                                    `Found existing configuration with version ${containerVersion}. Using existing files.`
                                );
                            } catch (e) {
                                log(`Failed to read docker-compose.yml: ${e.message}`);
                                vscode.window.showInformationMessage(
                                    `Found configuration with version ${containerVersion} but no docker-compose.yml. Will create new files.`
                                );
                            }
                        } else {
                            useExistingFiles = true;
                            log('Found existing files created by RSM extension');
                            vscode.window.showInformationMessage(
                                'Found existing configuration with latest version. Using existing files.'
                            );
                        }
                    } else {
                        log('Workspace file exists but was not created by RSM extension');
                        vscode.window.showInformationMessage(
                            'Found workspace file not created by RSM extension. Will create new files.'
                        );
                    }
                } catch (e) {
                    log(`Failed to read workspace file using wsl.exe cat: ${e.message}`);
                    
                    // Method 2: Try VS Code's file system API
                    log('Attempting to read workspace file using VS Code API...');
                    try {
                        const uri = vscode.Uri.file(workspaceFilePath);
                        const content = await vscode.workspace.fs.readFile(uri);
                        const workspaceContent = JSON.parse(content.toString());
                        log('Successfully read workspace file using VS Code API');
                        
                        if (workspaceContent.metadata?.createdBy === 'rsm-vscode-extension') {
                            // Same version checking logic as above
                            log('Found existing workspace file created by RSM extension');
                            const containerVersion = workspaceContent.metadata?.containerVersion;
                            if (containerVersion && containerVersion !== 'latest') {
                                try {
                                    await vscode.workspace.fs.stat(vscode.Uri.file(dockerComposePath));
                                    log('Found local docker-compose.yml file');
                                    useExistingFiles = true;
                                    vscode.window.showInformationMessage(
                                        `Found existing configuration with version ${containerVersion}. Using existing files.`
                                    );
                                } catch (e) {
                                    log(`Failed to find docker-compose.yml: ${e.message}`);
                                    vscode.window.showInformationMessage(
                                        `Found configuration with version ${containerVersion} but no docker-compose.yml. Will create new files.`
                                    );
                                }
                            } else {
                                useExistingFiles = true;
                                log('Found existing files created by RSM extension');
                                vscode.window.showInformationMessage(
                                    'Found existing configuration with latest version. Using existing files.'
                                );
                            }
                        }
                    } catch (e2) {
                        log(`Failed to read workspace file using VS Code API: ${e2.message}`);
                        log('No existing workspace file found or unable to read it');
                        vscode.window.showInformationMessage(
                            'No existing configuration found. Will create new files.'
                        );
                    }
                }
            } catch (e) {
                log(`All file reading attempts failed: ${e.message}`);
                vscode.window.showInformationMessage(
                    'No existing configuration found. Will create new files.'
                );
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