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

        // Create version-specific docker-compose directory
        const dockerComposeDir = path.join(currentPath, `docker-compose-${version}`);
        await fs.mkdir(dockerComposeDir, { recursive: true });

        // Copy and modify docker-compose template
        const isArm = os.arch() === 'arm64';
        const templateFile = path.join(context.extensionPath, 'docker-compose-latest',
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
                path.join(`docker-compose-${version}`,
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

        // Handle .code-workspace file
        const projectName = getProjectName(currentPath);
        const workspaceFile = path.join(currentPath, `${projectName}.code-workspace`);

        let workspaceContent;
        try {
            // Try to read existing workspace file
            const existingWorkspace = await fs.readFile(workspaceFile, 'utf8');
            workspaceContent = JSON.parse(existingWorkspace);

            // Update only the container version related settings
            if (workspaceContent.settings) {
                workspaceContent.settings["dev.containers.defaultExtensions"] = [
                    "ms-vscode-remote.remote-containers"
                ];
            }

            // Update metadata with new version and timestamp
            if (!workspaceContent.metadata) {
                workspaceContent.metadata = {};
            }
            workspaceContent.metadata.createdBy = "rsm-vscode-extension";
            workspaceContent.metadata.createdAt = new Date().toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
            workspaceContent.metadata.containerVersion = version;

            log('Updated existing .code-workspace file');
        } catch (error) {
            // If file doesn't exist or is invalid, create new workspace content
            log('Creating new .code-workspace file');
            workspaceContent = await createWorkspaceContent(version);
        }

        await fs.writeFile(
            workspaceFile,
            JSON.stringify(workspaceContent, null, 4),
            'utf8'
        );
        log('Saved .code-workspace file');

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