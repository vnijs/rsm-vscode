const { exec } = require('child_process');

const isWindows = process.platform === 'win32';

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

            // Split into lines and look for the one with (Default)
            const lines = stdout.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            // Skip the first line (header) and find the line with (Default)
            const defaultLine = lines.slice(1).find(line => line.includes('(Default)'));

            if (!defaultLine) {
                reject(new Error('No default WSL distribution found'));
                return;
            }

            // Extract everything before (Default)
            const distroName = defaultLine.trim().split(' (Default)')[0];
            resolve(distroName);
        });
    });
}

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

module.exports = {
    getDefaultDistro,
    getWSLUsername
};