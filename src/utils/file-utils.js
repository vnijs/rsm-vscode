const fs = require('fs');
const { spawn } = require('child_process');
const { log } = require('./logger');
const { isWindows, isMacOS } = require('./container-utils');
const vscode = require('vscode');
const path = require('path');
const { windowsPaths, macosPaths } = require('./path-utils');
const os = require('os');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

// Get the appropriate path utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

/**
 * Creates the devcontainer configuration content
 * @param {string} containerPath - The path in the container
 * @param {string} dockerComposePath - The path to the compose file
 * @param {boolean} isArm - Whether running on ARM architecture
 * @returns {Promise<Object>} The devcontainer configuration
 */
async function createDevcontainerContent(containerPath, dockerComposePath, isArm) {
    try {
        // Log input parameters
        log(`Creating devcontainer content with:
            containerPath: ${containerPath}
            dockerComposePath: ${dockerComposePath}
            isArm: ${isArm}
            isWindows: ${isWindows}`);

        // Get extension path and docker-compose directory
        const extensionPath = vscode.extensions.getExtension('vnijs.rsm-vscode').extensionPath;
        const dockerComposeDir = path.join(extensionPath, 'docker-compose');
        log(`Extension path: ${extensionPath}`);
        log(`Docker compose directory: ${dockerComposeDir}`);

        // Determine which template to use based on architecture and platform
        const templateName = `devcontainer-k8s-${isArm ? 'arm' : 'intel'}${isWindows ? '-win' : ''}.json`;
        const templatePath = path.join(dockerComposeDir, templateName);

        log(`Looking for template: ${templateName}`);
        log(`Full template path: ${templatePath}`);

        // Check if template exists
        try {
            await fs.promises.access(templatePath);
            log(`Template file exists at: ${templatePath}`);
        } catch (e) {
            log(`Template file not found at: ${templatePath}`);
            throw new Error(`Template file not found: ${templatePath}`);
        }

        // Read the template file
        log('Reading template file...');
        const templateContent = await fs.promises.readFile(templatePath, 'utf8');
        log(`Template content length: ${templateContent.length} bytes`);

        // Parse the template
        log('Parsing template JSON...');
        const config = JSON.parse(templateContent);
        log('Successfully parsed template JSON');

        // Update the paths
        log('Updating configuration paths...');
        config.workspaceFolder = containerPath;
        config.remoteWorkspaceFolder = containerPath;
        config.dockerComposeFile = [dockerComposePath];

        log(`Final configuration:
            workspaceFolder: ${config.workspaceFolder}
            remoteWorkspaceFolder: ${config.remoteWorkspaceFolder}
            dockerComposeFile: ${config.dockerComposeFile}`);

        return config;
    } catch (error) {
        log(`Error creating devcontainer content: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        throw error;
    }
}

/**
 * Creates the workspace configuration content
 * @returns {Object} The workspace configuration
 */
function createWorkspaceContent() {
    return {
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
}

/**
 * Writes content to a file, handling WSL paths on Windows
 * @param {object|string} content The content to write
 * @param {string} filePath The path to write to
 * @returns {Promise<boolean>}
 */
async function writeFile(content, filePath) {
    try {
        log(`Writing file to: ${filePath}`);
        log(`Content type: ${typeof content}`);

        const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 4);
        log(`Stringified content length: ${contentStr.length} bytes`);

        if (isWindows) {
            // Use WSL to write the file
            const wslPath = filePath.replace(/\\/g, '/');
            log(`Converting Windows path to WSL path: ${wslPath}`);

            const command = `echo '${contentStr.replace(/'/g, "'\\''")}' > '${wslPath}'`;
            log(`Executing WSL command: ${command.substring(0, 100)}...`);
            
            await execAsync(command, { shell: 'wsl.exe' });
            log('Successfully wrote file using WSL');
        } else {
            log('Writing file directly on macOS/Linux');
            await fs.promises.writeFile(filePath, contentStr);
            log('Successfully wrote file');
        }

        // Verify file was written
        try {
            await fs.promises.access(filePath);
            const stats = await fs.promises.stat(filePath);
            log(`File written successfully. Size: ${stats.size} bytes`);
        } catch (e) {
            log(`Warning: Could not verify file was written: ${e.message}`);
        }

        return true;
    } catch (error) {
        log(`Error writing file: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        throw error;
    }
}

/**
 * Gets the project name from a path
 * @param {string} path The path to extract the project name from
 * @returns {string}
 */
function getProjectName(path) {
    const parts = path.split(/[\/\\]/);
    return parts[parts.length - 1];
}

/**
 * Creates configuration files for a new workspace
 * @param {string} targetFolder - The folder to create configuration files in
 */
async function createConfigFiles(targetFolder) {
    try {
        // Convert target folder to local path if needed
        targetFolder = paths.toLocalPath(targetFolder);
        log(`Creating config files in: ${targetFolder}`);

        const isArm = process.arch === 'arm64';
        const extensionPath = vscode.extensions.getExtension('vnijs.rsm-vscode').extensionPath;

        // Create .devcontainer.json
        const devContainerPath = path.join(targetFolder, '.devcontainer.json');
        const dockerComposePath = path.join(extensionPath, 'docker-compose',
            `docker-compose-k8s-${isArm ? 'arm' : 'intel'}${isWindows ? '-win' : ''}.yml`
        );

        log(`Creating .devcontainer.json at: ${devContainerPath}`);
        log(`Using compose file: ${dockerComposePath}`);

        const devContainerContent = await createDevcontainerContent("/home/jovyan", dockerComposePath, isArm);

        // Create workspace file
        const workspaceFile = path.join(targetFolder, path.basename(targetFolder) + '.code-workspace');
        log(`Creating workspace file at: ${workspaceFile}`);

        const workspaceContent = createWorkspaceContent();

        // Use writeFile utility that handles path conversion
        await writeFile(devContainerContent, devContainerPath);
        await writeFile(workspaceContent, workspaceFile);

        log('Created configuration files successfully');
    } catch (error) {
        log(`Error creating configuration files: ${error.message}`);
        throw error;
    }
}

/**
 * Creates a temporary devcontainer file in the workspace
 * @param {object|string} content - The devcontainer.json content
 * @param {string} workspacePath - The workspace path where the file will be created
 * @returns {Promise<string>} Path to the created file
 */
async function createTemporaryDevContainer(content, workspacePath) {
    try {
        // Create the .devcontainer.json directly in the workspace
        const devContainerPath = path.join(workspacePath, '.devcontainer.json');
        log(`Creating temporary devcontainer at: ${devContainerPath}`);

        // Ensure content is a string
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 4);

        // Write the file
        if (isWindows) {
            const wslPath = devContainerPath.replace(/\\/g, '/');
            const command = `echo '${contentStr.replace(/'/g, "'\\''")}' > '${wslPath}'`;
            await execAsync(command, { shell: 'wsl.exe' });
            log('Created devcontainer file using WSL');
        } else {
            await fs.promises.writeFile(devContainerPath, contentStr);
            log('Created devcontainer file directly');
        }

        // Verify file was created
        try {
            await fs.promises.access(devContainerPath);
            const stats = await fs.promises.stat(devContainerPath);
            log(`Devcontainer file created successfully. Size: ${stats.size} bytes`);
        } catch (e) {
            log(`Warning: Could not verify devcontainer file was created: ${e.message}`);
        }

        return devContainerPath;
    } catch (error) {
        log(`Error creating devcontainer file: ${error.message}`);
        throw error;
    }
}

/**
 * Cleans up the temporary devcontainer file
 * @param {string} devContainerPath - Path to the devcontainer file
 * @param {string} workspacePath - The workspace path containing the file
 */
async function cleanupTemporaryDevContainer(devContainerPath, workspacePath) {
    try {
        // Remove the devcontainer file
        if (isWindows) {
            const wslPath = devContainerPath.replace(/\\/g, '/');
            await execAsync(`rm -f '${wslPath}'`, { shell: 'wsl.exe' });
            log('Removed devcontainer file using WSL');
        } else {
            await fs.promises.unlink(devContainerPath);
            log('Removed devcontainer file directly');
        }
    } catch (error) {
        log(`Error cleaning up devcontainer file: ${error.message}`);
        // Don't throw, just log the error
    }
}

module.exports = {
    writeFile,
    getProjectName,
    createConfigFiles,
    createDevcontainerContent,
    createWorkspaceContent,
    createTemporaryDevContainer,
    cleanupTemporaryDevContainer
}; 