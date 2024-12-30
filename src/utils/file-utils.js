const fs = require('fs');
const { spawn } = require('child_process');
const { log } = require('./logger');
const { isWindows } = require('./wsl-utils');

/**
 * Writes content to a file, handling WSL paths on Windows
 * @param {object} content The content to write
 * @param {string} filePath The path to write to
 * @returns {Promise<boolean>}
 */
async function writeFile(content, filePath) {
    if (isWindows) {
        const writeCmd = `wsl.exe bash -c 'cat > "${filePath}"'`;
        log(`Writing file using command: ${writeCmd}`);
        
        try {
            const proc = spawn('wsl.exe', ['bash', '-c', `cat > "${filePath}"`]);
            
            proc.stdin.write(JSON.stringify(content, null, 2));
            proc.stdin.end();
            
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
        } catch (error) {
            log(`Failed to write file: ${error.message}`);
            throw error;
        }
    } else {
        try {
            log(`Writing file directly at: ${filePath}`);
            fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
            log(`Successfully wrote file at: ${filePath}`);
            return true;
        } catch (error) {
            log(`Failed to write file: ${error.message}`);
            throw error;
        }
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

module.exports = {
    writeFile,
    getProjectName
}; 