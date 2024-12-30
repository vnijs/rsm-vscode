const vscode = require('vscode');
const path = require('path');
const { execCommand } = require('./wsl-utils');
const { log } = require('./logger');

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

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

module.exports = {
    isRemoteSession,
    isInContainer,
    windowsContainer,
    macosContainer,
    isWindows,
    isMacOS
}; 