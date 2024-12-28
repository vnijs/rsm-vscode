const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Global configuration storage
let globalState;
let outputChannel;

function activate(context) {
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('RSM VS Code');
    context.subscriptions.push(outputChannel);

    function log(message, popup = false) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        outputChannel.appendLine(logMessage);
        if (popup) {
            vscode.window.showInformationMessage(message);
        }
    }

    // Initial environment logging
    const envInfo = {
        remoteName: vscode.env.remoteName,
        remoteAuthority: vscode.env.remoteAuthority,
        shell: vscode.env.shell,
        uiKind: vscode.env.uiKind,
        appHost: vscode.env.appHost
    };
    log('VS Code Environment: ' + JSON.stringify(envInfo, null, 2));

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
                    
                    // Show info message about the change
                    vscode.window.showInformationMessage(
                        `Active workspace is now: ${workspacePath}`,
                        'Show Details'
                    ).then(selection => {
                        if (selection === 'Show Details') {
                            outputChannel.show();
                        }
                    });
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
        // Determine if we're on ARM architecture
        const isArm = os.arch() === 'arm64';
        const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
        const imageName = isArm ? 'vnijs/rsm-msba-k8s-arm:latest' : 'vnijs/rsm-msba-k8s-intel:latest';
        
        // Get the path to the docker-compose file
        const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
        
        log(`Using compose file: ${composeFile} for ${os.arch()} architecture`);

        // Verify compose file exists
        if (!fs.existsSync(composeFile)) {
            vscode.window.showErrorMessage(`Docker compose file not found: ${composeFile}`);
            return;
        }

        // Show progress while starting container
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Starting RSM container...",
            cancellable: false
        }, async (progress) => {
            try {
                // Start the container using docker-compose
                progress.report({ message: "Starting container with docker-compose..." });
                
                // Change to the docker-compose directory before running docker-compose
                const composeDir = path.dirname(composeFile);
                const command = `cd "${composeDir}" && docker-compose -f "${composeFileName}" up -d`;
                
                log(`Executing command: ${command}`);
                await execPromise(command);

                // Wait a moment for container to be ready
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Get the last used workspace folder or default to home
                const lastWorkspace = globalState.get('lastWorkspaceFolder');
                let workspaceFolder = '/home/jovyan';
               
                if (!lastWorkspace || lastWorkspace === '/home/jovyan') {
                    // If no previous workspace or using home, prompt for folder
                    const options = {
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        defaultUri: vscode.Uri.file(os.homedir()),
                        openLabel: 'Select Project Folder'
                    };

                    const result = await vscode.window.showOpenDialog(options);
                    if (result && result[0]) {
                        // Convert local path to container path
                        const localPath = result[0].fsPath;
                        workspaceFolder = localPath.replace(os.homedir(), '/home/jovyan');
                        // Store the selected workspace
                        await globalState.update('lastWorkspaceFolder', workspaceFolder);
                        log(`Selected new workspace: ${workspaceFolder}`);
                    }
                } else {
                    // Convert the stored container path to local path to check if it exists
                    const localPath = lastWorkspace.replace('/home/jovyan', os.homedir());
                    if (fs.existsSync(localPath)) {
                        workspaceFolder = lastWorkspace;
                        log(`Using stored workspace: ${workspaceFolder}`);
                    } else {
                        // If path doesn't exist, prompt for new folder
                        log(`Stored workspace not found: ${lastWorkspace}, prompting for new location`);
                        const options = {
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            defaultUri: vscode.Uri.file(os.homedir()),
                            openLabel: 'Select Project Folder'
                        };

                        const result = await vscode.window.showOpenDialog(options);
                        if (result && result[0]) {
                            // Convert local path to container path
                            const localPath = result[0].fsPath;
                            workspaceFolder = localPath.replace(os.homedir(), '/home/jovyan');
                            // Store the selected workspace
                            await globalState.update('lastWorkspaceFolder', workspaceFolder);
                            log(`Selected new workspace: ${workspaceFolder}`);
                        }
                    }
                }

                // Create devcontainer.json content
                const devcontainerContent = {
                    "name": imageName,
                    "dockerComposeFile": [
                        path.join(context.extensionPath, 'docker-compose', composeFileName)
                    ],
                    "service": "rsm-msba",
                    "workspaceFolder": workspaceFolder,
                    "remoteUser": "jovyan",
                    "overrideCommand": false,
                    "remoteWorkspaceFolder": workspaceFolder,
                    "remoteEnv": {
                        "VSCODE_REMOTE_CONTAINERS_DISPLAY_NAME": imageName
                    },
                    "containerEnv": {
                        "VSCODE_REMOTE_CONTAINERS_DISPLAY_NAME": imageName
                    },
                    "customizations": {
                        "vscode": {
                            "extensions": [
                                "ms-vscode-remote.remote-containers"
                            ]
                        }
                    }
                };

                // Create temporary .devcontainer directory and file
                const tempDir = path.join(os.homedir(), '.devcontainer');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir);
                }
                fs.writeFileSync(
                    path.join(tempDir, 'devcontainer.json'),
                    JSON.stringify(devcontainerContent, null, 2)
                );

                try {
                    // Connect to container directly without asking
                    await vscode.commands.executeCommand(
                        'remote-containers.openFolder',
                        vscode.Uri.file(os.homedir())
                    );
                } catch (error) {
                    log('Error attaching to container:', true);
                    log(`Full error: ${error.stack}`);
                }
            } catch (error) {
                log(`Failed to start container: ${error.message}`, true);  // Show in popup
                log(`Full error: ${error.stack}`);  // Full stack trace in log only
            }
        });
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

        const oldWorkspace = globalState.get('lastWorkspaceFolder');
        log(`Current workspace is: ${oldWorkspace || 'none'}`);

        const options = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(os.homedir()),
            openLabel: 'Select Project Folder'
        };

        const result = await vscode.window.showOpenDialog(options);
        if (result && result[0]) {
            const localPath = result[0].fsPath;
            const containerPath = localPath.replace(os.homedir(), '/home/jovyan');
            const folderName = path.basename(localPath);
            
            // Store the new workspace
            log(`Updating workspace to: ${containerPath}`);
            await globalState.update('lastWorkspaceFolder', containerPath);
            
            try {
                // Create .devcontainer.json in the target folder
                const isArm = os.arch() === 'arm64';
                const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
                const devcontainerContent = {
                    "name": "RSM-MSBA",
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
                    }
                };

                // Create workspace file
                const workspaceFile = path.join(localPath, `${folderName}.code-workspace`);
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
                    }
                };
                
                // Write both files
                const devcontainerPath = path.join(localPath, '.devcontainer.json');
                fs.writeFileSync(devcontainerPath, JSON.stringify(devcontainerContent, null, 2));
                fs.writeFileSync(workspaceFile, JSON.stringify(workspaceContent, null, 2));
                
                log(`Created workspace file: ${workspaceFile}`);
                log(`Created devcontainer file: ${devcontainerPath}`);

                // Open the workspace file directly in container
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(workspaceFile)
                );
                
                log(`Workspace changed to: ${containerPath}`);
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