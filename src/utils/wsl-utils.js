const { exec } = require('child_process');

const isWindows = process.platform === 'win32';

/**
 * Gets the default WSL distribution name
 * @returns {Promise<string|null>} The name of the default distribution, or null if not on Windows
 */
function getDefaultDistro() {
    return new Promise((resolve, reject) => {
        if (!isWindows) {
            resolve(null);
            return;
        }
        exec('wsl.exe -l', { encoding: 'utf16le' }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            
            const lines = stdout.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            const defaultLine = lines.slice(1).find(line => line.includes('(Default)'));
            
            if (!defaultLine) {
                reject(new Error('No default WSL distribution found'));
                return;
            }
            
            const distroName = defaultLine.trim().split(' (Default)')[0];
            resolve(distroName);
        });
    });
}

/**
 * Gets the current WSL username
 * @returns {Promise<string|null>} The WSL username, or null if not on Windows
 */
function getWSLUsername() {
    return new Promise((resolve, reject) => {
        if (!isWindows) {
            resolve(null);
            return;
        }
        exec('wsl.exe whoami', (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Executes a command in WSL if on Windows, or directly if on other platforms
 * @param {string} command The command to execute
 * @returns {Promise<string>} The command output
 */
function execCommand(command) {
    if (isWindows) {
        return execPromise(`wsl.exe bash -c '${command.replace(/'/g, "\\'")}'`);
    }
    return execPromise(command);
}

/**
 * Promise wrapper for exec
 * @param {string} command The command to execute
 * @returns {Promise<string>} The command output
 */
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

module.exports = {
    getDefaultDistro,
    getWSLUsername,
    execCommand,
    execPromise,
    isWindows
}; 