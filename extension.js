const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Extension version for tracking changes
const EXTENSION_VERSION = "2024.1.3.12";

// Global configuration storage
let globalState;
let outputChannel;

// Platform detection
const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

// Helper function to execute shell commands
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
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

// Platform-specific path conversions
const pathUtils = {
    // Windows WSL path conversions
    windows: {
        toContainerPath(wslPath) {
            const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
            if (match) {
                return `/home/jovyan/${match[2]}`;
            }
            return wslPath;
        },
        toWSLPath(wslPath) {
            const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
            if (match) {
                return `/home/${match[1]}/${match[2]}`;
            }
            return wslPath;
        },
        toWSLMountPath(winPath) {
            return winPath
                .replace(/^([A-Za-z]):/, '/mnt/$1')
                .replace(/\\/g, '/')
                .toLowerCase();
        },
        isWSLPath(path) {
            return path.startsWith('\\\\wsl.localhost\\');
        }
    },
    // macOS path conversions
    macos: {
        toContainerPath(localPath) {
            return localPath.replace(os.homedir(), '/home/jovyan');
        },
        toLocalPath(containerPath) {
            return containerPath.replace('/home/jovyan', os.homedir());
        },
        toWSLMountPath(path) {
            return path; // No conversion needed on macOS
        },
        isWSLPath() {
            return false; // macOS never has WSL paths
        }
    }
};

// Get the appropriate path utilities based on platform
const paths = isWindows ? pathUtils.windows : pathUtils.macos;

// Helper function to execute commands
async function execCommand(command) {
    if (isWindows) {
        // For Windows, wrap command in WSL
        return execPromise(`wsl.exe bash -c '${command.replace(/'/g, "\\'")}'`);
    }
    return execPromise(command);
}

// Helper function to check if we're in a remote environment
function isRemoteSession() {
    return process.env.REMOTE_CONTAINERS === 'true' || 
           process.env.REMOTE_CONTAINERS_IPC || 
           process.env.VSCODE_REMOTE_CONTAINERS_SESSION ||
           vscode.env.remoteName === 'dev-container';
}

// Helper function to check if we're in the container
async function isInContainer() {
    try {
        // Check both environment variables and VS Code remote name
        const inContainer = isRemoteSession();
        log(`Container check: remoteName=${vscode.env.remoteName}, inContainer=${inContainer}`);
        return inContainer;
    } catch (error) {
        log(`Error checking container status: ${error.message}`);
        return false;
    }
}

// Helper function to write file
async function writeFile(content, filePath) {
    if (isWindows) {
        // Use cat to write the file directly in WSL
        const writeCmd = `wsl.exe bash -c 'cat > "${filePath}"'`;
        log(`Writing file using command: ${writeCmd}`);
        log(`Writing content: ${JSON.stringify(content, null, 2)}`);
        
        // Use child_process.spawn to pipe the file content
        const spawn = require('child_process').spawn;
        const proc = spawn('wsl.exe', ['bash', '-c', `cat > "${filePath}"`]);
        
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
        
        log(`Successfully wrote file to WSL path: ${filePath}`);
        return true;
    } else {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
        return true;
    }
}

// Platform-specific container operations
const containerOps = {
    windows: {
        async getDefaultDistro() {
            const result = await execPromise('wsl.exe -l -v');
            const lines = result.split('\n');
            const defaultLine = lines.find(line => line.includes('*'));
            if (!defaultLine) {
                throw new Error('No default WSL distribution found');
            }
            return defaultLine.split('*')[0].trim();
        },
        getComposeFile(isArm, context) {
            return path.join(context.extensionPath, 'docker-compose', 
                isArm ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-intel-win.yml');
        },
        async openInContainer(wslPath) {
            const defaultDistro = await this.getDefaultDistro();
            return vscode.Uri.parse(`vscode-remote://wsl+${defaultDistro}${wslPath}`);
        },
        async stopContainer(context) {
            const isArm = os.arch() === 'arm64';
            const composeFileName = isArm ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-intel-win.yml';
            const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
            const composeDir = path.dirname(composeFile);
            await execCommand(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
        }
    },
    macos: {
        async getDefaultDistro() {
            return ''; // Not needed on macOS
        },
        getComposeFile(isArm, context) {
            return path.join(context.extensionPath, 'docker-compose',
                isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml');
        },
        async openInContainer(localPath) {
            return vscode.Uri.file(localPath);
        },
        async stopContainer(context) {
            const isArm = os.arch() === 'arm64';
            const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
            const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
            const composeDir = path.dirname(composeFile);
            await execCommand(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
        }
    }
};

// Get the appropriate container operations based on platform
const container = isWindows ? containerOps.windows : containerOps.macos;

function activate(context) {
    // Create output channel first so we can use logging
    outputChannel = vscode.window.createOutputChannel('RSM VS Code');
    context.subscriptions.push(outputChannel);
    
    // Show version in info bubble only (no modal)
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

    // Command to start and attach to container
    let startContainer = vscode.commands.registerCommand('rsm-vscode.startContainer', async function () {
        // Check if we have a workspace folder selected
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            const msg = isWindows ? 
                'Please open a folder in WSL2 first (File > Open Folder... and select a folder starting with \\\\wsl.localhost\\)' :
                'Please open a folder first (File > Open Folder...)';
            log(msg);
            vscode.window.showErrorMessage(msg);
            return;
        }

        // Get the current path and convert to proper paths
        const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        log(`Current path: ${currentPath}`);

        // Convert paths for different uses - using platform-specific utilities
        const wslPath = paths.toWSLPath(currentPath);
        const containerPath = paths.toContainerPath(currentPath);
        
        log(`Path for writing: ${wslPath}`);
        log(`Container path: ${containerPath}`);

        // Validate path based on platform
        if (isWindows && !paths.isWSLPath(currentPath)) {
            const msg = 'Please select a folder in the WSL2 filesystem (\\\\wsl.localhost\\...)';
            log(msg);
            vscode.window.showErrorMessage(msg);
            return;
        }

        try {
            // Get project name from path
            const projectName = getProjectName(containerPath);
            log(`Project name: ${projectName}`);

            // Determine architecture and compose file
            const isArm = os.arch() === 'arm64';
            const composeFile = container.getComposeFile(isArm, context);
            
            // Convert extension path to mount format if needed
            const wslComposeFile = paths.toWSLMountPath(composeFile);
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
                    "remote.autoForwardPorts": true,
                    "workbench.confirmBeforeOpen": false
                },
                "extensions": {
                    "recommendations": [
                        "ms-vscode-remote.remote-containers"
                    ]
                }
            };

            // Write the files using proper paths
            const devcontainerPath = `${wslPath}/.devcontainer.json`;
            const workspacePath = `${wslPath}/${projectName}.code-workspace`;
            
            log(`Creating .devcontainer.json at ${devcontainerPath}`);
            await writeFile(devcontainerContent, devcontainerPath);
            
            log(`Creating workspace file at ${workspacePath}`);
            await writeFile(workspaceContent, workspacePath);
            
            // Log the paths we're going to use
            log(`Opening folder in container: ${containerPath}`);

            // Open the folder using platform-specific method
            const uri = await container.openInContainer(wslPath);
            log(`Opening with URI: ${uri.toString()}`);
            
            await vscode.commands.executeCommand('remote-containers.openFolder', uri);
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
                // Convert container path back to local path using platform-specific utilities
                const localPath = paths.toLocalPath(currentFolder.uri.path);
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(localPath),
                    { forceReuseWindow: true }
                );
                
                // Wait a moment for the window to reopen
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Stop the container using platform-specific method
                await container.stopContainer(context);
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
            shell: vscode.env.shell,
            uiKind: vscode.env.uiKind,
            appHost: vscode.env.appHost,
            platform: process.platform,
            arch: os.arch(),
            inContainer: isRemoteSession(),
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

    // Helper function to get project name from path
    function getProjectName(path) {
        const parts = path.split(/[\/\\]/);
        return parts[parts.length - 1];
    }

    // Command to change workspace
    let changeWorkspace = vscode.commands.registerCommand('rsm-vscode.changeWorkspace', async function () {
        if (!(await isInContainer())) {
            vscode.window.showErrorMessage('Not connected to the RSM container');
            return;
        }

        try {
            // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
            if (!currentFolder) {
                throw new Error('No workspace folder found');
            }

            // Get the new workspace folder
            const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
                title: 'Select New Workspace Folder'
            });

        if (result && result[0]) {
                const newPath = result[0].fsPath;
                log(`Selected new workspace path: ${newPath}`);

                // Convert paths using platform-specific utilities
                const wslPath = paths.toWSLPath(newPath);
                const containerPath = paths.toContainerPath(newPath);
                
                log(`WSL path: ${wslPath}`);
                log(`Container path: ${containerPath}`);

                // Validate path based on platform
                if (isWindows && !paths.isWSLPath(newPath)) {
                    const msg = 'Please select a folder in the WSL2 filesystem (\\\\wsl.localhost\\...)';
                    log(msg);
                    vscode.window.showErrorMessage(msg);
                    return;
                }

                // Create workspace file if it doesn't exist
                const projectName = getProjectName(containerPath);
                const workspaceFile = `${wslPath}/${projectName}.code-workspace`;
                
                // Create workspace content
                    const workspaceContent = {
                    "folders": [{ "path": "." }],
                        "settings": {
                            "remote.containers.defaultExtensions": [
                            "ms-vscode-remote.remote-containers"
                        ],
                        "workspace.openFolderWhenFileOpens": true,
                        "remote.autoForwardPorts": true,
                        "workbench.confirmBeforeOpen": false
                    },
                    "extensions": {
                        "recommendations": [
                                "ms-vscode-remote.remote-containers"
                            ]
                    }
                };

                // Write workspace file
                await writeFile(workspaceContent, workspaceFile);
                log(`Created workspace file at: ${workspaceFile}`);

                // Open the workspace using platform-specific method
                const uri = await container.openInContainer(wslPath);
                log(`Opening with URI: ${uri.toString()}`);
                
                await vscode.commands.executeCommand('remote-containers.openFolder', uri);
                    log(`Workspace changed to: ${containerPath}`);
                } else {
                log('No workspace folder selected');
                vscode.window.showErrorMessage('Workspace change cancelled: No folder selected');
                }
            } catch (error) {
                log(`Error during workspace change: ${error.message}`);
                vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
        }
    });

    // Command to debug container environment
    let debugContainer = vscode.commands.registerCommand('rsm-vscode.debugContainer', async function () {
        const terminal = await vscode.window.createTerminal({
            name: 'RSM Debug',
            shellPath: isWindows ? 'wsl.exe' : '/bin/zsh'
        });
        
        const containerChecks = {
            remoteName: vscode.env.remoteName,
            inContainer: isRemoteSession(),
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

function deactivate() {}

module.exports = {
    activate,
    deactivate
} 