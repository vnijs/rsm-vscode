const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { log } = require('./logger');
const { isWindows } = require('./container-utils');
const { getWSLUsername } = require('./wsl-utils');

/**
 * Get the appropriate Docker Compose file based on system architecture and OS
 * @param {vscode.ExtensionContext} context - The extension context
 * @returns {string} Path to the Docker Compose file
 */
function getComposeFile(context) {
    const isArm = os.arch() === 'arm64';
    const composeFileName = isArm
        ? (isWindows ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-arm.yml')
        : (isWindows ? 'docker-compose-k8s-intel-win.yml' : 'docker-compose-k8s-intel.yml');

    return path.join(context.extensionPath, 'docker-compose-latest', composeFileName);
}

/**
 * Check if the RSM container is running
 * @returns {Promise<boolean>} True if container is running, false otherwise
 */
async function isContainerRunning() {
    try {
        const { stdout } = await execAsync('docker ps --format "{{.Names}}" | grep rsm-msba-k8s-latest');
        return !!stdout.trim();
    } catch (error) {
        return false;
    }
}

/**
 * Start the RSM container using Docker Compose
 * @param {vscode.ExtensionContext} context - The extension context
 */
async function dockerComposeUp(context) {
    try {
        // Check if container is already running
        if (await isContainerRunning()) {
            vscode.window.showInformationMessage('RSM container is already running');
            return;
        }

        const composeFile = getComposeFile(context);
        const composeDir = path.dirname(composeFile);
        const composeFileName = path.basename(composeFile);

        log(`Starting container using compose file: ${composeFileName}`);

        // On Windows, we need to get the WSL username
        let env = { ...process.env };
        if (isWindows) {
            try {
                const wslUser = await getWSLUsername();
                if (wslUser) {
                    env.WSL_USER = wslUser.trim();
                    log(`Using WSL user: ${wslUser.trim()}`);
                }
            } catch (error) {
                log(`Failed to get WSL username: ${error.message}`);
            }
        }

        await execAsync(`cd "${composeDir}" && docker-compose -f "${composeFileName}" up -d`, { env });
        vscode.window.showInformationMessage('RSM container started successfully');
    } catch (error) {
        log(`Failed to start container: ${error.message}`, true);
        vscode.window.showErrorMessage(`Failed to start container: ${error.message}`);
    }
}

/**
 * Stop the RSM container using Docker Compose
 * @param {vscode.ExtensionContext} context - The extension context
 */
async function dockerComposeDown(context) {
    try {
        // Check if container is running
        if (!(await isContainerRunning())) {
            vscode.window.showInformationMessage('No RSM container is currently running');
            return;
        }

        const composeFile = getComposeFile(context);
        const composeDir = path.dirname(composeFile);
        const composeFileName = path.basename(composeFile);

        log(`Stopping container using compose file: ${composeFileName}`);
        await execAsync(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
        vscode.window.showInformationMessage('RSM container stopped successfully');
    } catch (error) {
        log(`Failed to stop container: ${error.message}`, true);
        vscode.window.showErrorMessage(`Failed to stop container: ${error.message}`);
    }
}

module.exports = {
    dockerComposeUp,
    dockerComposeDown,
    isContainerRunning
}; 