const vscode = require('vscode');
const { isWindows, isInContainer } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { getProjectName, createWorkspaceContent } = require('./file-utils');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

async function setContainerVersionCommand(context) {
    try {
        // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            vscode.window.showErrorMessage('Please open a folder first');
            return;
        }

        // Get the current path and convert if needed
        let currentPath = currentFolder.uri.fsPath;
        if (isInContainer()) {
            // Convert container path to local path for file operations
            currentPath = paths.toLocalPath(currentPath);
        }
        log(`Current path: ${currentPath}`);

        // Ask user for version
        const version = await vscode.window.showQuickPick(
            ['latest', '1.0.0'],
            {
                placeHolder: 'Select container version',
                title: 'RSM Container Version'
            }
        );

        if (!version) {
            log('User cancelled version selection');
            return;
        }

        log(`Selected version: ${version}`);

        // Create docker-compose directory if it doesn't exist
        const dockerComposeDir = path.join(currentPath, 'docker-compose');
        await fs.mkdir(dockerComposeDir, { recursive: true });

        // Copy and modify docker-compose template
        const isArm = os.arch() === 'arm64';
        const templateFile = path.join(context.extensionPath, 'docker-compose',
            isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml');

        let composeContent = await fs.readFile(templateFile, 'utf8');

        // Update version in compose file
        composeContent = composeContent
            .replace(
                /(vnijs\/rsm-msba-k8s-(?:arm|intel)):\S+/g,
                `$1:${version}`
            )
            .replace(
                /(container_name: rsm-msba-k8s-)\S+/g,
                `$1${version}`
            );

        // Write modified compose file
        const localComposeFile = path.join(dockerComposeDir,
            isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml');
        await fs.writeFile(localComposeFile, composeContent, 'utf8');
        log(`Created docker-compose file: ${localComposeFile}`);

        // For .devcontainer.json, we need the workspace folder in container format
        const containerWorkspacePath = isInContainer() ?
            `/home/jovyan${currentPath.replace(os.homedir(), '')}` : // Convert current container path to standard format
            `/home/jovyan${currentPath.replace(os.homedir(), '')}`; // Convert local path to container format

        // Create .devcontainer.json
        const devcontainerContent = {
            name: `rsm-msba-k8s-${version}`,
            dockerComposeFile: [
                path.join('docker-compose',
                    isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml')
            ],
            service: "rsm-msba",
            workspaceFolder: containerWorkspacePath,
            remoteUser: "jovyan",
            overrideCommand: false,
            customizations: {
                vscode: {
                    extensions: [
                        "ms-vscode-remote.remote-containers"
                    ],
                    settings: {
                        "workbench.welcomePage.walkthroughs.openOnInstall": false,
                        "workbench.startupEditor": "none"
                    }
                }
            },
            remoteEnv: {
                HOME: "/home/jovyan"
            }
        };

        await fs.writeFile(
            path.join(currentPath, '.devcontainer.json'),
            JSON.stringify(devcontainerContent, null, 4),
            'utf8'
        );
        log('Created .devcontainer.json');

        // Create .code-workspace file
        const projectName = getProjectName(currentPath);
        const workspaceContent = await createWorkspaceContent(version);
        await fs.writeFile(
            path.join(currentPath, `${projectName}.code-workspace`),
            JSON.stringify(workspaceContent, null, 4),
            'utf8'
        );
        log('Created .code-workspace file');

        vscode.window.showInformationMessage(`Container version set to ${version}`);

    } catch (error) {
        log(`Error in setContainerVersion: ${error.message}`, true);
        log(`Full error: ${error.stack}`);
        vscode.window.showErrorMessage(`Failed to set container version: ${error.message}`);
    }
}

module.exports = {
    setContainerVersionCommand
}; 