const vscode = require('vscode');
const path = require('path');
const { execCommand } = require('./wsl-utils');
const { log } = require('./logger');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');
const fs = require('fs');
const { windowsPaths, macosPaths } = require('./path-utils');

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

// Get the appropriate path utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;

/**
 * Handles container conflicts by checking for and optionally stopping existing containers
 * @returns {Promise<boolean>} True if conflict was resolved, false if no conflict or user declined
 */
async function handleContainerConflict(error) {
    // Check if error indicates a container conflict or port conflict
    if (error && error.message && (
        error.message.includes('container name is already in use') ||
        error.message.includes('Conflict. The container name') ||
        error.message.includes('port is already allocated') ||
        error.message.includes('Bind for 127.0.0.1:') ||
        error.message.includes('failed programming external connectivity') ||
        error.message.includes('bind to is already in use') ||
        error.message.toLowerCase().includes('port') && error.message.toLowerCase().includes('use')
    )) {
        log('Detected container or port conflict');
        log(`Full error message: ${error.message}`);

        // Ask user if they want to stop the existing container
        const response = await vscode.window.showWarningMessage(
            'A container or its ports are already in use. Would you like to stop existing containers and continue?',
            'Yes, Stop Containers',
            'No, Cancel'
        );

        if (response === 'Yes, Stop Containers') {
            try {
                log('Attempting to stop existing containers');

                // First try to stop any containers with matching ports
                try {
                    const { stdout: portContainers } = await execAsync(
                        'docker ps --format "{{.Names}}" --filter publish=8765'
                    );
                    if (portContainers) {
                        const containers = portContainers.split('\n').filter(name => name);
                        log(`Found containers using our ports: ${containers.join(', ')}`);
                        for (const containerName of containers) {
                            log(`Stopping container with matching ports: ${containerName}`);
                            await execAsync(`docker stop ${containerName}`);
                            await execAsync(`docker rm ${containerName}`);
                        }
                    }
                } catch (portError) {
                    log(`Error checking port usage: ${portError.message}`);
                }

                // Then try to stop any rsm-msba containers
                try {
                    const { stdout: rsmContainers } = await execAsync(
                        'docker ps --format "{{.Names}}" | grep -E "rsm-msba|rsm-msba-k8s"'
                    );
                    if (rsmContainers) {
                        const containers = rsmContainers.split('\n').filter(name => name);
                        log(`Found RSM containers: ${containers.join(', ')}`);
                        for (const containerName of containers) {
                            log(`Stopping RSM container: ${containerName}`);
                            await execAsync(`docker stop ${containerName}`);
                            await execAsync(`docker rm ${containerName}`);
                        }
                    }
                } catch (rsmError) {
                    log(`Error checking RSM containers: ${rsmError.message}`);
                }

                // Finally, try docker compose down as a last resort
                try {
                    log('Attempting docker compose down as final cleanup');
                    const isArm = process.arch === 'arm64';
                    const composeFileName = isArm ?
                        (isWindows ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-arm.yml') :
                        (isWindows ? 'docker-compose-k8s-intel-win.yml' : 'docker-compose-k8s-intel.yml');

                    await execAsync(`docker compose -f ${composeFileName} down`);
                    log('Successfully ran docker compose down');
                } catch (composeError) {
                    log(`Error with docker compose down: ${composeError.message}`);
                }

                // Wait for cleanup
                await new Promise(resolve => setTimeout(resolve, 2000));
                return true;
            } catch (error) {
                log(`Error during container cleanup: ${error.message}`);
                return false;
            }
        } else {
            log('User declined to stop existing containers');
            return false;
        }
    }
    return false;
}

/**
 * Checks if we're in a remote environment
 * @returns {boolean}
 */
function isRemoteSession() {
    return process.env.REMOTE_CONTAINERS === 'true' || 
           !!process.env.REMOTE_CONTAINERS_IPC || 
           !!process.env.VSCODE_REMOTE_CONTAINERS_SESSION ||
           vscode.env.remoteName === 'dev-container';
}

/**
 * Checks if we're in the container
 * @returns {Promise<boolean>}
 */
async function isInContainer() {
    try {
        const inContainer = isRemoteSession();
        log(`Container check: remoteName=${vscode.env.remoteName}, inContainer=${inContainer}`);
        return inContainer;
    } catch (error) {
        log(`Error checking container status: ${error.message}`);
        return false;
    }
}

const windowsContainer = {
    async getDefaultDistro() {
        try {
            const { exec } = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(exec);
            const { stdout } = await execAsync('wsl.exe -l', { encoding: 'utf16le' });
            const lines = stdout.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            const defaultLine = lines.slice(1).find(line => line.includes('(Default)'));
            if (!defaultLine) {
                throw new Error('No default WSL distribution found');
            }
            const distroName = defaultLine.trim().split(' (Default)')[0];
            return distroName;
        } catch (error) {
            log(`Error getting default distro: ${error.message}`);
            return 'Ubuntu-22.04'; // Fallback value
        }
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
        const isArm = process.arch === 'arm64';
        const composeFileName = isArm ? 'docker-compose-k8s-arm-win.yml' : 'docker-compose-k8s-intel-win.yml';
        const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
        const composeDir = path.dirname(composeFile);
        await execCommand(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
    }
};

const macosContainer = {
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
        const isArm = process.arch === 'arm64';
        const composeFileName = isArm ? 'docker-compose-k8s-arm.yml' : 'docker-compose-k8s-intel.yml';
        const composeFile = path.join(context.extensionPath, 'docker-compose', composeFileName);
        const composeDir = path.dirname(composeFile);
        await execCommand(`cd "${composeDir}" && docker-compose -f "${composeFileName}" down`);
    }
};

/**
 * Gets the container version from a .devcontainer.json file
 * @param {string} filePath - Path to the .devcontainer.json file
 * @returns {Promise<string>} Container version (e.g., 'latest', '0.1.0')
 */
async function getContainerVersion(filePath) {
    try {
        const fs = require('fs').promises;
        const content = await fs.readFile(filePath, 'utf8');
        const config = JSON.parse(content);
        const dockerComposeFile = config.dockerComposeFile;

        if (dockerComposeFile) {
            // Convert dockerComposeFile path to local path
            const localPath = paths.toLocalPath(dockerComposeFile);
            const composeContent = await fs.readFile(localPath, 'utf8');
            const match = composeContent.match(/vnijs\/rsm-msba-k8s-(?:arm|intel):(\S+)/);
            return match ? match[1] : 'latest';
        }
    } catch (error) {
        log(`Error getting container version: ${error.message}`);
    }
    return 'latest'; // Default to latest if we can't determine version
}

/**
 * Stops the current container if needed before switching workspaces
 * @param {string} currentFolder - Current workspace folder
 * @param {string} targetFolder - Target workspace folder
 * @returns {Promise<boolean>} True if container was stopped, false otherwise
 */
async function stopContainerIfNeeded(currentFolder, targetFolder) {
    try {
        // Convert paths if we're in a container
        if (await isInContainer()) {
            currentFolder = paths.toLocalPath(currentFolder);
            targetFolder = paths.toLocalPath(targetFolder);
        }

        log(`Checking paths - Current: ${currentFolder}, Target: ${targetFolder}`);

        // Check for any containers using our ports
        try {
            // Use docker port to check for port usage
            const { stdout: containers } = await execAsync('docker ps -q');
            const containerIds = containers.split('\n').filter(id => id);

            let containersUsingPort = [];
            for (const id of containerIds) {
                try {
                    const { stdout: ports } = await execAsync(`docker port ${id}`);
                    if (ports.includes('8765')) {
                        const { stdout: name } = await execAsync(`docker inspect --format '{{.Name}}' ${id}`);
                        containersUsingPort.push(name.trim().replace(/^\//, ''));
                    }
                } catch (e) {
                    // Ignore errors for individual containers
                    log(`Error checking ports for container ${id}: ${e.message}`);
                }
            }

            if (containersUsingPort.length > 0) {
                log(`Found containers using port 8765: ${containersUsingPort.join(', ')}`);

                // Ask user if they want to stop the existing containers
                const response = await vscode.window.showWarningMessage(
                    'Found containers using required ports. Would you like to stop them before continuing?',
                    'Yes, Stop Containers',
                    'No, Cancel'
                );

                if (response === 'Yes, Stop Containers') {
                    for (const containerName of containersUsingPort) {
                        log(`Stopping container with matching ports: ${containerName}`);
                        await execAsync(`docker stop ${containerName}`);
                        await execAsync(`docker rm ${containerName}`);
                    }
                    // Wait for cleanup
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return true;
                } else {
                    log('User declined to stop existing containers');
                    return false;
                }
            }
        } catch (portError) {
            log(`Error checking port usage: ${portError.message}`);
        }

        return false;
    } catch (error) {
        log(`Error in stopContainerIfNeeded: ${error.message}`);
        return false;
    }
}

module.exports = {
    isRemoteSession,
    isInContainer,
    windowsContainer,
    macosContainer,
    isWindows,
    isMacOS,
    handleContainerConflict,
    stopContainerIfNeeded
}; 