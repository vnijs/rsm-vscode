const fs = require('fs');
const { spawn } = require('child_process');
const { log } = require('./logger');
const { isWindows } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;


/**
 * Writes content to a file, handling WSL paths on Windows
 * @param {object|string} content The content to write
 * @param {string} filePath The path to write to
 * @returns {Promise<boolean>}
 */
async function writeFile(content, filePath) {
    try {
        // Validate file path
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Invalid file path: path must be a non-empty string');
        }
        filePath = filePath.trim();

        log(`Writing file to: ${filePath}`);
        log(`Content type: ${typeof content}`);

        const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 4);
        log(`Stringified content length: ${contentStr.length} bytes`);

        if (isWindows) {
            const wslFilePath = paths.toWSLPath(filePath);
            const writeCmd = `wsl.exe bash -c 'cat > "${wslFilePath}"'`;
            log(`Writing file using command: ${writeCmd}`);

            try {
                const proc = spawn('wsl.exe', ['bash', '-c', `cat > "${wslFilePath}"`]);
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

                log(`Successfully wrote file to WSL path: ${wslFilePath}`);
                return true;
            } catch (error) {
                log(`Failed to write file: ${error.message}`);
                throw error;
            }
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

module.exports = {
    writeFile
}; 