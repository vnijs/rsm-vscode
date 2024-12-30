const vscode = require('vscode');
const { exec } = require('child_process');
const util = require('util');
const { log } = require('./logger');
const { writeFile } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const { windowsContainer } = require('./container-utils');
const { isInContainer, isWindows, isMacOS } = require('./container-utils');
const os = require('os');

/**
 * Test file path handling in different environments.
 * For detailed documentation on path handling, see:
 * src/utils/path-handling.md
 */

const execAsync = util.promisify(exec);

async function readFileWSL(path) {
    try {
        // Remove any @ symbol at the start of the path
        const cleanPath = path.replace(/^@/, '');
        const { stdout } = await execAsync(`wsl.exe bash -c 'cat "${cleanPath}"'`);
        return stdout;
    } catch (e) {
        throw new Error(`Failed to read file: ${e.message}`);
    }
}

async function readFileMacOS(path) {
    try {
        // Use direct file reading on macOS
        const fs = require('fs').promises;
        const content = await fs.readFile(path, 'utf8');
        return content;
    } catch (error) {
        throw new Error(`Failed to read file: ${e.message}`);
    }
}

const readFile = isWindows ? readFileWSL : readFileMacOS;

async function testFilePathsCommand() {
    const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const content = 'test content';
    const wslUsername = await getWSLUsername();
    const inContainer = await isInContainer();
    
    // Only try to get defaultDistro if not in container
    const defaultDistro = !inContainer ? (await windowsContainer.getDefaultDistro() || 'Ubuntu-22.04') : 'Ubuntu-22.04';
    
    log('=== File Path Test Results ===');
    log(`Current workspace path: ${currentPath}`);
    log(`Remote name: ${vscode.env.remoteName}`);
    log(`In container: ${vscode.env.remoteName === 'dev-container'}`);
    log(`Platform: ${process.platform}`);

    if (isWindows) {
        log(`WSL username: ${wslUsername}`);
        log(`WSL distro: ${defaultDistro}`);

        // Test reading an existing file with different path formats
        log('\n=== Testing Read Operations ===');
        const baseReadPath = `/home/${wslUsername}/test3/test-file-to-read.txt`;
        const readPaths = [
            baseReadPath,                                        // Direct WSL path
            `\\\\wsl.localhost\\${defaultDistro}${baseReadPath}`, // Windows WSL path
            `@\\\\wsl.localhost\\${defaultDistro}${baseReadPath}`, // With @ symbol
            baseReadPath.replace(/\//g, '\\'),                   // Backslash version
            '/mnt/c/Users/vnijs/test-file-to-read-win.txt',         // Windows path through WSL
            'C:\\Users\\vnijs\\test-file-to-read-win.txt'           // Direct Windows path
        ];

        for (const path of readPaths) {
            log(`\nTesting read from path: ${path}`);
            try {
                const content = await readFile(path);
                log(`✅ Read succeeded. Content length: ${content.length}`);
                log(`Content: ${content.trim()}`);
            } catch (e) {
                log(`❌ Read failed: ${e.message}`);
            }
        }

        // Test write operations
        log('\n=== Testing Write Operations ===');
        const testPaths = [
            `${currentPath}/test1.txt`,                          // Original path
            currentPath.replace(/\\/g, '/') + '/test2.txt',      // Forward slashes
            `/home/${wslUsername}/test3/test4.txt`,              // WSL user path
            `/home/jovyan/test3/test5.txt`,                      // Container path
            `\\home\\jovyan\\test3\\test6.txt`,                  // Windows-style container path
        ];

        for (const path of testPaths) {
            log(`\nTesting path: ${path}`);
            try {
                log('Testing writeFile utility...');
                await writeFile(content, path);
                log('✅ writeFile utility succeeded');

                try {
                    const readContent = await readFile(path);
                    log(`Content match: ${readContent.trim() === content}`);
                    log(`Written content: "${content}"`);
                    log(`Read content: "${readContent.trim()}"`);
                } catch (e) {
                    log(`❌ Could not read file back: ${e.message}`);
                }
            } catch (e) {
                log(`❌ writeFile utility failed: ${e.message}`);
            }
        }
    } else if (isMacOS) {
        // Test reading an existing file with different path formats
        log('\n=== Testing Read Operations on macOS ===');
        const baseReadPath = `${os.homedir()}/test3/test-file-to-read.txt`;
        const readPaths = [
            baseReadPath,                                        // Direct path
            baseReadPath.replace(/\//g, '\\'),                   // Backslash version
            '/Users/vnijs/test-file-to-read-mac.txt',            // macOS path
            '/Macintosh HD/Users/vnijs/test-file-to-read-mac.txt' // Direct macOS path
        ];

        for (const path of readPaths) {
            log(`\nTesting read from path: ${path}`);
            try {
                const content = await readFile(path);
                log(`✅ Read succeeded. Content length: ${content.length}`);
                log(`Content: ${content.trim()}`);
            } catch (e) {
                log(`❌ Read failed: ${e.message}`);
            }
        }

        // Test write operations
        log('\n=== Testing Write Operations on macOS ===');
        const testPaths = [
            `${currentPath}/test1.txt`,                          // Original path
            currentPath.replace(/\\/g, '/') + '/test2.txt',      // Forward slashes
            `${os.homedir()}/test3/test4.txt`,                   // User path
            '/Users/vnijs/test3/test4.txt',                      // macOS path
            '/Macintosh HD/Users/vnijs/test3/test5.txt'          // Direct macOS path
        ];

        for (const path of testPaths) {
            log(`\nTesting path: ${path}`);
            try {
                log('Testing writeFile utility...');
                await writeFile(content, path);
                log('✅ writeFile utility succeeded');

                try {
                    const readContent = await readFile(path);
                    log(`Content match: ${readContent.trim() === content}`);
                    log(`Written content: "${content}"`);
                    log(`Read content: "${readContent.trim()}"`);
                } catch (e) {
                    log(`❌ Could not read file back: ${e.message}`);
                }
            } catch (e) {
                log(`❌ writeFile utility failed: ${e.message}`);
            }
        }
    }
    
    log('\n=== Test Complete ===');
    vscode.window.showInformationMessage('File path tests complete. Check Output for results.');
}

module.exports = {
    testFilePathsCommand
};
