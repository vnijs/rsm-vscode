const vscode = require('vscode');
const { exec } = require('child_process');
const util = require('util');
const { log } = require('./logger');
const { writeFile } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const { windowsContainer } = require('./container-utils');
const { isInContainer } = require('./container-utils');

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
            const content = await readFileWSL(path);
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
        `\\\\wsl.localhost\\${defaultDistro}\\${currentPath.replace(/\\/g, '/')}/test3.txt`, // WSL path
        `/home/${wslUsername}/test3/test4.txt`,              // WSL user path
        `/home/jovyan/test3/test5.txt`,                      // Container path
        `\\home\\jovyan\\test3\\test6.txt`,                  // Windows-style container path
        '/mnt/c/Users/vnijs/test7.txt',                      // Windows path through WSL
        'C:\\Users\\vnijs\\test8.txt'                        // Direct Windows path
    ];
    
    for (const path of testPaths) {
        log(`\nTesting path: ${path}`);
        try {
            log('Testing writeFile utility...');
            await writeFile(content, path);
            log('✅ writeFile utility succeeded');
            
            try {
                const readContent = await readFileWSL(path);
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
    
    log('\n=== Test Complete ===');
    vscode.window.showInformationMessage('File path tests complete. Check Output for results.');
}

module.exports = {
    testFilePathsCommand
}; 
