const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Extension version for tracking changes
const EXTENSION_VERSION = "2024.1.2.23";

// Global configuration storage
let globalState;
let outputChannel;

// Helper function to convert Windows WSL path to container path
function convertToContainerPath(wslPath) {
    // Match the pattern: \\wsl.localhost\DISTRO\home\USERNAME\PATH
    const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
    if (match) {
        // match[2] is the rest of the path after username
        return `/home/jovyan/${match[2]}`;
    }
    return wslPath;
}

// Helper function to convert Windows WSL path to proper WSL path
function convertToWSLPath(wslPath) {
    // Match the pattern: \\wsl.localhost\DISTRO\home\USERNAME\PATH
    const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
    if (match) {
        // match[1] is the username, match[2] is the rest of the path
        return `/home/${match[1]}/${match[2]}`;
    }
    return wslPath;
}

// Helper function to convert Windows path to WSL mount path
function convertToWSLMountPath(winPath) {
    // Convert C:\path\to\file to /mnt/c/path/to/file
    return winPath
        .replace(/^([A-Za-z]):/, '/mnt/$1')
        .replace(/\\/g, '/')
        .toLowerCase();
}

// Global logging function
    function log(message, popup = false) {
    if (!outputChannel) return;  // Guard against early calls
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        outputChannel.appendLine(logMessage);
        if (popup) {
            vscode.window.showInformationMessage(message);
        }
    }

// Helper function to get WSL paths
async function getWSLPaths() {
    try {
        // First check if WSL is available
        log('Checking if WSL is available...');
        try {
            await execPromise('where wsl.exe');
            log('WSL.exe found');
        } catch (error) {
            log(`WSL.exe not found: ${error.message}`);
            return null;
        }

        // Get the WSL home path (for use inside WSL/Docker)
        log('Getting WSL home path...');
        const wslHome = await execPromise('wsl.exe bash -c \'echo $HOME\'');
        if (!wslHome || !wslHome.trim()) {
            log('WSL home path is empty');
            return null;
        }
        const wslHomePath = wslHome.trim();
        log(`Found WSL home path: ${wslHomePath}`);
        
        // Get the Windows-accessible WSL path
        log('Getting Windows-accessible WSL path...');
        const windowsPath = await execPromise('wsl.exe bash -c \'wslpath -w $HOME\'');
        if (!windowsPath || !windowsPath.trim()) {
            log('Windows-accessible WSL path is empty');
            return null;
        }
        const windowsAccessPath = windowsPath.trim();
        log(`Found Windows-accessible WSL path: ${windowsAccessPath}`);
        
        // Verify the paths exist using a single bash command
        log('Verifying paths exist...');
        const checkCmd = 'wsl.exe bash -c \'if [ -d "$HOME" ]; then echo "yes"; else echo "no"; fi\'';
        log(`Running check command: ${checkCmd}`);
        const checkPath = await execPromise(checkCmd);
        if (checkPath.trim() !== 'yes') {
            log(`WSL home directory does not exist: ${wslHomePath}`);
            return null;
        }
        log('Path verification successful');
        
        return {
            wslHome: wslHomePath,         // e.g., /home/vnijs
            windowsPath: windowsAccessPath // e.g., \\wsl.localhost\Ubuntu-22.04\home\vnijs
        };
    } catch (error) {
        log(`Error getting WSL paths: ${error.message}`);
        log(`Full error stack: ${error.stack}`);
        return null;
    }
}

// Helper function to get list of WSL distributions
async function getWSLDistributions() {
    try {
        const output = await execPromise('wsl.exe -l -v');
        const lines = output.split('\n')
            .filter(line => line.trim() && !line.includes('Windows Subsystem for Linux Distributions:'))
            .map(line => {
                const parts = line.trim().split(/\s+/);
                return {
                    name: parts[0],
                    state: parts[1],
                    version: parts[2]
                };
            });
        return lines;
    } catch (error) {
        return [];
    }
}

// Helper function to get WSL home directory for a specific distribution
async function getWSLHomeForDistro(distroName) {
    try {
        const output = await execPromise(`wsl.exe -d ${distroName} echo $HOME`);
        return output.trim();
    } catch (error) {
        return null;
    }
}

// Helper function to copy files to WSL home
async function copyToWSLHome(sourcePath, wslHome) {
    try {
        // Create .rsm-vscode directory in WSL home if it doesn't exist
        const rsmDir = '.rsm-vscode';
        await execPromise(`wsl.exe bash -c 'mkdir -p ${wslHome}/${rsmDir}'`);
        
        // Copy the file to WSL
        const fileName = path.basename(sourcePath);
        const wslPath = `${wslHome}/${rsmDir}/${fileName}`;
        const wslSourcePath = sourcePath.replace(/^([A-Za-z]):/, '/mnt/$1').replace(/\\/g, '/').toLowerCase();
        
        // Use bash -c to ensure paths are handled correctly in WSL
        const copyCmd = `wsl.exe bash -c 'cp "${wslSourcePath}" "${wslPath}"'`;
        log(`Running copy command: ${copyCmd}`);
        await execPromise(copyCmd);
        log(`Copied ${sourcePath} to ${wslPath}`);
        
        return wslPath;
    } catch (error) {
        log(`Error copying file to WSL: ${error.message}`);
        throw error;
    }
}

// Helper function to write file in WSL
async function writeFileToWSL(content, wslPath) {
    try {
        // Ensure forward slashes in the path
        const targetPath = wslPath.replace(/\\/g, '/');
        
        // Use cat to write the file directly in WSL
        const writeCmd = `wsl.exe bash -c 'cat > "${targetPath}"'`;
        log(`Writing file using command: ${writeCmd}`);
        log(`Writing content: ${JSON.stringify(content, null, 2)}`);
        
        // Use child_process.spawn to pipe the file content
        const spawn = require('child_process').spawn;
        const proc = spawn('wsl.exe', ['bash', '-c', `cat > "${targetPath}"`]);
        
        // Write the content
        proc.stdin.write(JSON.stringify(content, null, 2));
        proc.stdin.end();
        
        // Wait for the process to complete
        await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                log(`Process exited with code: ${code}`);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to write file, exit code: ${code}`));
                }
            });
        });
        
        log(`Successfully wrote file to WSL path: ${targetPath}`);
        return true;
    } catch (error) {
        log(`Error writing file to WSL: ${error.message}`);
        throw error;
    }
}

// Helper function to get default WSL distribution
async function getDefaultWSLDistro() {
    try {
        // Use wsl.exe -l -v to get detailed distribution info
        const result = await execPromise('wsl.exe -l -v');
        // Look for the line with a * indicating default distribution
        const lines = result.split('\n');
        const defaultLine = lines.find(line => line.includes('*'));
        if (!defaultLine) {
            throw new Error('No default WSL distribution found');
        }
        // Extract distribution name (first column, trimmed)
        const distro = defaultLine.split('*')[0].trim();
        log(`Default WSL distribution: ${distro}`);
        return distro;
    } catch (error) {
        log(`Error getting WSL distribution: ${error.message}`);
        throw error;
    }
}

// Helper function to convert Windows WSL path to WSL path
async function convertWinWSLToWSLPath(winPath) {
    // Convert \\wsl.localhost\Ubuntu-22.04\home\vnijs\test2 to /home/vnijs/test2
    const distro = await getDefaultWSLDistro();
    if (winPath.startsWith(`\\\\wsl.localhost\\${distro}\\`)) {
        const parts = winPath.split('\\');
        const homeIndex = parts.findIndex(p => p === 'home');
        if (homeIndex === -1) return winPath;
        
        // Take only the parts from 'home' onwards
        return '/' + parts.slice(homeIndex).join('/');
    }
    return winPath;
}

// Helper function to convert WSL path to container path
function convertWSLToContainerPath(wslPath) {
    // Convert /home/vnijs/test2 to /home/jovyan/test2
    const parts = wslPath.split('/');
    if (parts.length >= 3 && parts[1] === 'home') {
        parts[2] = 'jovyan';  // Replace username with jovyan
        return parts.join('/');
    }
    return wslPath;
}

// Helper function to validate WSL2 path
async function isWSL2Path(path) {
    const distro = await getDefaultWSLDistro();
    return path.startsWith(`\\\\wsl.localhost\\${distro}\\`);
}

// Helper function to get project name from path
function getProjectName(path) {
    const parts = path.split(/[\/\\]/);
    return parts[parts.length - 1];
}

function activate(context) {
    // Create output channel first so we can use logging
    outputChannel = vscode.window.createOutputChannel('RSM VS Code');
    context.subscriptions.push(outputChannel);
    
    // Show version popup immediately
    vscode.window.showInformationMessage(
        `RSM VS Code Extension - Current branch version: ${EXTENSION_VERSION}`,
        { modal: true }
    );
    log(`Extension Version: ${EXTENSION_VERSION}`, true);

    // Store the global state for later use
    globalState = context.globalState;

    // Add workspace change listener with popup confirmation
    let workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(async event => {
        if (await isInContainer()) {
            const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (currentFolder) {
                const workspacePath = currentFolder.uri.fsPath;
                const oldWorkspace = globalState.get('lastWorkspaceFolder');
                
                // Show confirmation dialog
                const message = `Workspace changing from:\n${oldWorkspace || 'none'}\nto:\n${workspacePath}`;
                const response = await vscode.window.showInformationMessage(
                    message,
                    'Update Saved Location',
                    'Keep Previous'
                );
                
                if (response === 'Update Saved Location') {
                    log(`Updating workspace to: ${workspacePath}`);
                    await globalState.update('lastWorkspaceFolder', workspacePath);
                    vscode.window.showInformationMessage(`Workspace location updated to: ${workspacePath}`);
                } else {
                    log(`Keeping previous workspace: ${oldWorkspace}`);
                }
            }
        }
    });

    // Add window state change listener with feedback
    let windowListener = vscode.window.onDidChangeWindowState(async windowState => {
        if (await isInContainer()) {
            const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (currentFolder) {
                const workspacePath = currentFolder.uri.fsPath;
                const oldWorkspace = globalState.get('lastWorkspaceFolder');
                
                if (oldWorkspace !== workspacePath) {
                    log(`Window changed, current workspace: ${workspacePath}`);
                    log(`Previous workspace was: ${oldWorkspace}`);
                }
            }
        }
    });

    // Add the listeners to subscriptions so they get cleaned up
    context.subscriptions.push(workspaceListener);
    context.subscriptions.push(windowListener);

    // Initial workspace logging
    const lastWorkspace = globalState.get('lastWorkspaceFolder');
    log(`Stored workspace at activation: ${lastWorkspace}`);

    // Helper function to check if we're in the container
    async function isInContainer() {
        // First check if we're in a dev container
        if (vscode.env.remoteName === 'dev-container') {
            log('In dev container based on remoteName');
            
            // Optional: Add additional checks if needed
            const containerChecks = {
                pwd: await new Promise(r => exec('pwd', (err, stdout) => r(stdout.trim()))),
                whoami: await new Promise(r => exec('whoami', (err, stdout) => r(stdout.trim())))
            };
            log(`Container details: ${JSON.stringify(containerChecks, null, 2)}`);
            
            return true;
        }
        
        log('Not in dev container based on remoteName');
        return false;
    }

    // Helper function to execute commands in the container
    async function execInContainer(command) {
        const terminal = await vscode.window.createTerminal({
            name: 'RSM Command',
            shellPath: '/bin/bash'
        });
        
        return new Promise((resolve, reject) => {
            let output = '';
            const listener = vscode.window.onDidWriteTerminalData(e => {
                if (e.terminal === terminal) {
                    output += e.data;
                }
            });
            
            terminal.sendText(command);
            // Give the command some time to execute
            setTimeout(() => {
                listener.dispose();
                terminal.dispose();
                resolve(output);
            }, 1000);
        });
    }

    // Command to start and attach to container
    let startContainer = vscode.commands.registerCommand('rsm-vscode.startContainer', async function () {
        // Check if we have a workspace folder selected
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            const msg = 'Please open a folder in WSL2 first (File > Open Folder... and select a folder starting with \\\\wsl.localhost\\)';
            log(msg);
            vscode.window.showErrorMessage(msg);
            return;
        }

        // Get the current path and convert to proper paths
        const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        log(`Current path: ${currentPath}`);

        // Convert paths for different uses - all synchronous now
        const wslPath = convertToWSLPath(currentPath);
        const containerPath = convertToContainerPath(currentPath);
        
        log(`WSL path for writing: ${wslPath}`);
        log(`Container path: ${containerPath}`);

        // If path wasn't converted, it's not a valid WSL2 path
        if (containerPath === currentPath) {
            const msg = 'Please select a folder in the WSL2 filesystem (\\\\wsl.localhost\\...)';
            log(msg);
            vscode.window.showErrorMessage(msg);
            return;
        }

        try {
            // Get project name from path
            const projectName = path.basename(containerPath);
            log(`Project name: ${projectName}`);

            // Determine architecture and compose file
            const isArm = os.arch() === 'arm64';
            const composeFile = path.join(context.extensionPath, 'docker-compose', 
                isArm ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-intel-win.yml');
            
            // Convert extension path to WSL mount format for container - synchronous
            const wslComposeFile = convertToWSLMountPath(composeFile);
            log(`Using compose file: ${wslComposeFile}`);

            // Create .devcontainer.json content
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
                        "extensions": ["ms-vscode-remote.remote-containers"]
                    }
                },
                "remoteEnv": {
                    "HOME": "/home/jovyan"
                }
            };

            // Create workspace file content
            const workspaceContent = {
                "folders": [{ "path": "." }],
                "settings": {
                    "remote.containers.defaultExtensions": [
                        "ms-vscode-remote.remote-containers"
                    ],
                    "workspace.openFolderWhenFileOpens": true,
                    "remote.autoForwardPorts": true
                },
                "extensions": {
                    "recommendations": [
                        "ms-vscode-remote.remote-containers"
                    ]
                }
            };

            // Write the files using proper WSL paths
            const devcontainerPath = `${wslPath}/.devcontainer.json`;
            const workspacePath = `${wslPath}/${projectName}.code-workspace`;
            
            log(`Creating .devcontainer.json at ${devcontainerPath}`);
            await writeFileToWSL(devcontainerContent, devcontainerPath);
            
            log(`Creating workspace file at ${workspacePath}`);
            await writeFileToWSL(workspaceContent, workspacePath);
            
            // Log the paths we're going to use
            log(`Opening folder in container: ${containerPath}`);

            // Get the default WSL distro before opening folder
            const defaultDistro = await getDefaultWSLDistro();
            
            // Log the paths for debugging
            log(`Default WSL distro: ${defaultDistro}`);
            log(`WSL path: ${wslPath}`);
            log(`Attempting to open: vscode-remote://wsl+${defaultDistro}${wslPath}`);
            
            // Use the detected distro in the URI
            try {
                await vscode.commands.executeCommand(
                    'remote-containers.openFolder',
                    vscode.Uri.parse(`vscode-remote://wsl+${defaultDistro}${wslPath}`)
                );
            } catch (error) {
                log(`Error opening folder: ${error.message}`);
                log(`Attempted path: vscode-remote://wsl+${defaultDistro}${wslPath}`);
                throw error; // Re-throw to be caught by outer catch block
            }
        } catch (error) {
            log('Error attaching to container:', true);
            log(`Full error: ${error.stack}`);
            vscode.window.showErrorMessage(`Failed to attach to container: ${error.message}`);
        }
    });

    // Command to stop and detach from container
    let stopContainer = vscode.commands.registerCommand('rsm-vscode.stopContainer', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Not connected to the RSM container');
            return;
        }

        try {
            // Store current workspace before detaching
            const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (currentFolder) {
                const workspacePath = currentFolder.uri.fsPath;
                log(`Storing workspace before detaching: ${workspacePath}`);
                await globalState.update('lastWorkspaceFolder', workspacePath);
            }

            // First, reopen the workspace locally
            if (currentFolder) {
                // Convert container path back to local path
                const localPath = currentFolder.uri.path.replace('/home/jovyan', os.homedir());
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(localPath),
                    { forceReuseWindow: true }
                );
                
                // Wait a moment for the window to reopen
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Then stop the container using docker-compose
                const isArm = os.arch() === 'arm64';
                const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
                const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
                const composeDir = path.dirname(composeFile);
                
                await execPromise(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
                vscode.window.showInformationMessage('Container stopped successfully');
            } else {
                throw new Error('No workspace folder found');
            }
        } catch (error) {
            log(`Failed to stop container: ${error.message}`, true);
            log(`Full error: ${error.stack}`);
        }
    });

    // Command to start Radiant
    let startRadiant = vscode.commands.registerCommand('rsm-vscode.startRadiant', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Start and Attach to Container"');
            return;
        }

        try {
            // Create and show terminal
            const terminal = await vscode.window.createTerminal({
                name: 'Radiant',
                shellPath: '/bin/zsh'
            });
            
            terminal.show();
            
            // Execute radiant in the terminal
            terminal.sendText('/usr/local/bin/radiant');
        } catch (error) {
            log(`Failed to start Radiant: ${error.message}`, true);
            log(`Full error: ${error.stack}`);
            vscode.window.showErrorMessage(`Failed to start Radiant: ${error.message}`);
        }
    });

    // Command to start GitGadget
    let startGitGadget = vscode.commands.registerCommand('rsm-vscode.startGitGadget', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Start and Attach to Container"');
            return;
        }

        try {
            // Create and show terminal
            const terminal = await vscode.window.createTerminal({
                name: 'GitGadget',
                shellPath: '/bin/zsh'
            });
            
            terminal.show();
            
            // Execute gitgadget in the terminal
            terminal.sendText('/usr/local/bin/gitgadget');
        } catch (error) {
            log(`Failed to start GitGadget: ${error.message}`, true);
            log(`Full error: ${error.stack}`);
            vscode.window.showErrorMessage(`Failed to start GitGadget: ${error.message}`);
        }
    });

    // Command to clean R and Python packages
    let cleanPackages = vscode.commands.registerCommand('rsm-vscode.cleanPackages', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Start and Attach to Container"');
            return;
        }

        try {
            // Create and show terminal
            const terminal = await vscode.window.createTerminal({
                name: 'Clean Packages',
                shellPath: '/bin/zsh'
            });
            
            terminal.show();
            
            // Execute clean command
            terminal.sendText('/usr/local/bin/clean');
        } catch (error) {
            log(`Failed to clean packages: ${error.message}`, true);
            log(`Full error: ${error.stack}`);
            vscode.window.showErrorMessage(`Failed to clean packages: ${error.message}`);
        }
    });

    // Command to setup RSM-MSBA container
    let setupContainer = vscode.commands.registerCommand('rsm-vscode.setupContainer', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Please connect to the RSM container first using "RSM: Start and Attach to Container"');
            return;
        }

        try {
            // Create and show terminal
            const terminal = await vscode.window.createTerminal({
                name: 'Setup Container',
                shellPath: '/bin/zsh'
            });
            
            terminal.show();
            
            // Execute setup command
            terminal.sendText('/usr/local/bin/setup');
        } catch (error) {
            log(`Failed to setup container: ${error.message}`, true);
            log(`Full error: ${error.stack}`);
            vscode.window.showErrorMessage(`Failed to setup container: ${error.message}`);
        }
    });

    // Debug command to check environment
    let debugEnv = vscode.commands.registerCommand('rsm-vscode.debugEnv', async function () {
        const envInfo = {
            remoteName: vscode.env.remoteName,
            remoteAuthority: vscode.env.remoteAuthority,
            shell: vscode.env.shell,
            uiKind: vscode.env.uiKind,
            appHost: vscode.env.appHost,
            isContainer: await isInContainer()
        };
        
        // Show in output channel
        log('Environment Debug Info:');
        log(JSON.stringify(envInfo, null, 2));
        
        // Show popup with key info
        const message = `Remote name: ${envInfo.remoteName}\nIn container: ${envInfo.isContainer}`;
        vscode.window.showInformationMessage(message, 'Show Full Log').then(selection => {
            if (selection === 'Show Full Log') {
                outputChannel.show();
            }
        });
    });

    // Add command to change workspace folder with enhanced feedback
    let changeWorkspace = vscode.commands.registerCommand('rsm-vscode.changeWorkspace', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Please connect to the RSM container first');
            return;
        }

        // Check if we're running in WSL2
        const wsl2Enabled = await isWSL2();
        let hostHomeDir = os.homedir();
        if (wsl2Enabled) {
            const wslHome = await getWSLHomeDir();
            if (wslHome) {
                hostHomeDir = wslHome;
                log(`Using WSL2 home directory: ${hostHomeDir}`);
            } else {
                log('Failed to get WSL2 home directory, falling back to Windows home');
            }
        }

        // Check current folder for workspace files
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (currentFolder) {
            const currentPath = currentFolder.uri.fsPath;
            // Convert container path to local path if needed
            let currentLocalPath = currentPath.includes('/home/jovyan') ?
                currentPath.replace('/home/jovyan', hostHomeDir) : currentPath;
            if (wsl2Enabled) {
                currentLocalPath = await convertToWindowsPath(currentLocalPath);
            }
            const currentFolderName = path.basename(currentLocalPath);

            try {
                const hasWorkspaceFile = fs.readdirSync(currentLocalPath)
                    .some(f => f.endsWith('.code-workspace'));

                // If no workspace file exists, ask if user wants to create one
                if (!hasWorkspaceFile) {
                    const createFiles = await vscode.window.showQuickPick(
                        ['Yes', 'No'],
                        {
                            placeHolder: `Would you like to create workspace configuration files in "${currentFolderName}" before switching?`
                        }
                    );

                    if (createFiles === 'Yes') {
                        try {
                            const isArm = os.arch() === 'arm64';
                            const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';

                            // Create .devcontainer.json with WSL2 settings if needed
                            const devcontainerContent = {
                                "name": isArm ? "rsm-msba-arm" : "rsm-msba-intel",
                                "dockerComposeFile": [
                                    path.join(context.extensionPath, 'docker-compose', composeFileName)
                                ],
                                "service": "rsm-msba",
                                "workspaceFolder": currentPath,
                                "remoteUser": "jovyan",
                                "overrideCommand": false,
                                "remoteWorkspaceFolder": currentPath,
                                "shutdownAction": "none",
                                "customizations": {
                                    "vscode": {
                                        "extensions": [
                                            "ms-vscode-remote.remote-containers"
                                        ]
                                    }
                                },
                                // Add WSL2 specific settings
                                "remoteEnv": wsl2Enabled ? {
                                    "HOME": "/home/jovyan"
                                } : undefined
                            };

                            // Create workspace file with metadata
                            const workspaceContent = {
                                "folders": [
                                    {
                                        "path": "."
                                    }
                                ],
                                "settings": {
                                    "remote.containers.defaultExtensions": [
                                        "ms-vscode-remote.remote-containers"
                                    ]
                                },
                                "metadata": {
                                    "rsmExtension": true,
                                    "created": new Date().toISOString()
                                }
                            };

                            // Write both files using local path
                            const devcontainerPath = path.join(currentLocalPath, '.devcontainer.json');
                            const workspaceFile = path.join(currentLocalPath, `${currentFolderName}.code-workspace`);

                            fs.writeFileSync(devcontainerPath, JSON.stringify(devcontainerContent, null, 2));
                            fs.writeFileSync(workspaceFile, JSON.stringify(workspaceContent, null, 2));

                            log(`Created workspace file in current folder: ${workspaceFile}`);
                            log(`Created devcontainer file in current folder: ${devcontainerPath}`);
                        } catch (error) {
                            log(`Error creating workspace files in current folder: ${error.message}`);
                        }
                    }
                }
            } catch (error) {
                log(`Error checking current folder: ${error.message}`);
            }
        }

        const oldWorkspace = globalState.get('lastWorkspaceFolder');
        log(`Current workspace is: ${oldWorkspace || 'none'}`);

        const options = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(hostHomeDir),
            openLabel: 'Select Project Folder'
        };

        const result = await vscode.window.showOpenDialog(options);
        if (result && result[0]) {
            let localPath = result[0].fsPath;
            if (wsl2Enabled) {
                localPath = await convertToWSLPath(localPath);
            }
            const containerPath = localPath.replace(hostHomeDir, '/home/jovyan');
            const folderName = path.basename(localPath);
            
            // Store the new workspace
            log(`Updating workspace to: ${containerPath}`);
            await globalState.update('lastWorkspaceFolder', containerPath);
            
            try {
                // Check for existing workspace files
                const ourWorkspaceFile = path.join(localPath, `${folderName}.code-workspace`);
                const existingWorkspaceFiles = fs.readdirSync(localPath)
                    .filter(f => f.endsWith('.code-workspace'))
                    .map(f => path.join(localPath, f));

                let workspaceToUse = null;
                let needCreateOurs = true;

                // Check if our workspace file exists
                if (existingWorkspaceFiles.includes(ourWorkspaceFile)) {
                    // Read it to verify it's ours
                    const content = JSON.parse(fs.readFileSync(ourWorkspaceFile, 'utf8'));
                    if (content.metadata?.rsmExtension === true) {
                        workspaceToUse = ourWorkspaceFile;
                        needCreateOurs = false;
                        log('Found our workspace file, using it directly');
                    }
                }

                // If we don't have our file but others exist
                if (!workspaceToUse && existingWorkspaceFiles.length > 0) {
                    const useExisting = await vscode.window.showQuickPick(
                        ['Create new workspace file', 'Use existing workspace file'],
                        {
                            placeHolder: 'Found existing workspace file(s). What would you like to do?'
                        }
                    );

                    if (useExisting === 'Use existing workspace file') {
                        // If multiple workspace files exist, let user pick
                        if (existingWorkspaceFiles.length === 1) {
                            workspaceToUse = existingWorkspaceFiles[0];
                        } else {
                            const selected = await vscode.window.showQuickPick(
                                existingWorkspaceFiles.map(f => path.basename(f)),
                                { placeHolder: 'Select workspace file to use' }
                            );
                            if (selected) {
                                workspaceToUse = path.join(localPath, selected);
                            }
                        }
                        needCreateOurs = false;
                    }
                }

                if (needCreateOurs) {
                    // Create .devcontainer.json in the target folder with WSL2 settings if needed
                    const isArm = os.arch() === 'arm64';
                    const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
                    const devcontainerContent = {
                        "name": isArm ? "rsm-msba-arm" : "rsm-msba-intel",
                        "dockerComposeFile": [
                            path.join(context.extensionPath, 'docker-compose', composeFileName)
                        ],
                        "service": "rsm-msba",
                        "workspaceFolder": containerPath,
                        "remoteUser": "jovyan",
                        "overrideCommand": false,
                        "remoteWorkspaceFolder": containerPath,
                        "shutdownAction": "none",
                        "customizations": {
                            "vscode": {
                                "extensions": [
                                    "ms-vscode-remote.remote-containers"
                                ]
                            }
                        },
                        // Add WSL2 specific settings
                        "remoteEnv": wsl2Enabled ? {
                            "HOME": "/home/jovyan"
                        } : undefined
                    };

                    // Create our workspace file with metadata
                    const workspaceContent = {
                        "folders": [
                            {
                                "path": "."
                            }
                        ],
                        "settings": {
                            "remote.containers.defaultExtensions": [
                                "ms-vscode-remote.remote-containers"
                            ]
                        },
                        "metadata": {
                            "rsmExtension": true,
                            "created": new Date().toISOString()
                        }
                    };

                    // Write both files
                    const devcontainerPath = path.join(localPath, '.devcontainer.json');
                    fs.writeFileSync(devcontainerPath, JSON.stringify(devcontainerContent, null, 2));
                    fs.writeFileSync(ourWorkspaceFile, JSON.stringify(workspaceContent, null, 2));

                    log(`Created workspace file: ${ourWorkspaceFile}`);
                    log(`Created devcontainer file: ${devcontainerPath}`);

                    workspaceToUse = ourWorkspaceFile;
                }

                if (workspaceToUse) {
                    // Convert workspace file path to Windows path if needed
                    let workspaceFilePath = workspaceToUse;
                    if (wsl2Enabled) {
                        workspaceFilePath = await convertToWindowsPath(workspaceToUse);
                    }
                    
                    // Open the workspace file directly in container
                    await vscode.commands.executeCommand(
                        'remote-containers.openWorkspace',
                        vscode.Uri.file(workspaceFilePath)
                    );

                    log(`Workspace changed to: ${containerPath}`);
                } else {
                    log('No workspace file selected or created');
                    vscode.window.showErrorMessage('Workspace change cancelled: No workspace file selected or created');
                }
            } catch (error) {
                log(`Error during workspace change: ${error.message}`);
                vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
            }
        }
    });

    // Debug command to check container status
    let debugContainer = vscode.commands.registerCommand('rsm-vscode.debugContainer', async function () {
        const terminal = await vscode.window.createTerminal({
            name: 'RSM Debug',
            shellPath: '/bin/zsh'
        });
        
        const containerChecks = {
            radiantExists: false,
            jovyanUser: false,
            jovyanHome: false,
            remoteName: vscode.env.remoteName,
            pwd: '',
            whoami: ''
        };

        try {
            terminal.sendText('test -f /usr/local/bin/radiant && echo "true" || echo "false"');
            terminal.sendText('id jovyan > /dev/null 2>&1 && echo "true" || echo "false"');
            terminal.sendText('test -d /home/jovyan && echo "true" || echo "false"');
            terminal.sendText('pwd');
            terminal.sendText('whoami');
            terminal.sendText('echo $SHELL');
            
            // Show the terminal for debugging
            terminal.show();
            
            log('Container Status Debug Info:');
            log(JSON.stringify(containerChecks, null, 2));
            
            vscode.window.showInformationMessage(
                'Container debug information shown in terminal',
                'Show Log'
            ).then(selection => {
                if (selection === 'Show Log') {
                    outputChannel.show();
                }
            });
        } catch (error) {
            log(`Debug check failed: ${error.message}`);
            terminal.dispose();
        }
    });

    context.subscriptions.push(startContainer);
    context.subscriptions.push(stopContainer);
    context.subscriptions.push(startRadiant);
    context.subscriptions.push(startGitGadget);
    context.subscriptions.push(cleanPackages);
    context.subscriptions.push(setupContainer);
    context.subscriptions.push(debugEnv);
    context.subscriptions.push(changeWorkspace);
    context.subscriptions.push(debugContainer);
}

// Helper function to promisify exec
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.toString());
            }
        });
    });
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
} 