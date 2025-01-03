const vscode = require('vscode');
const { log } = require('./logger');
const { windowsPaths } = require('./path-utils');
const { getWSLUsername, getDefaultDistro } = require('./wsl-utils');
const { writeFile } = require('./file-utils');
const { isInContainer } = require('./container-utils');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

async function readFileWSL(path) {
    try {
        const { stdout } = await execAsync(`wsl.exe bash -c 'cat "${path}"'`);
        return stdout;
    } catch (e) {
        throw new Error(`Failed to read file: ${e.message}`);
    }
}

async function testWindowsCompatCommand() {
    const currentPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const inContainer = await isInContainer();
    const wslUsername = await getWSLUsername();
    const defaultDistro = await getDefaultDistro();

    log('\n=== Windows Compatibility Test Results ===');
    log(`Current workspace path: ${currentPath}`);
    log(`In container: ${inContainer}`);
    log(`WSL username: ${wslUsername}`);
    log(`WSL distro: ${defaultDistro}`);

    // Test 1: Path Conversions
    log('\n=== Testing Path Conversions ===');
    const testPaths = {
        wsl: `/home/${wslUsername}/test`,
        windows: `C:\\Users\\${wslUsername}\\test`,
        container: '/home/jovyan/test'
    };

    log('\nConverting paths:');
    log(`WSL -> Container: ${windowsPaths.toContainerPath(testPaths.wsl)}`);
    log(`Windows -> WSL: ${windowsPaths.toWSLMountPath(testPaths.windows)}`);
    const localPath = await windowsPaths.toLocalPath(testPaths.container);
    log(`Container -> Local: ${localPath}`);

    // Test 2: File Operations
    log('\n=== Testing File Operations ===');
    const testContent = {
        metadata: {
            createdBy: 'rsm-vscode-extension',
            containerVersion: '0.1.0'
        }
    };

    // Test different path formats for writing
    const testFiles = [
        `/home/${wslUsername}/test/test1.json`,
        `/mnt/c/Users/${wslUsername}/test/test2.json`,
        inContainer ? '/home/jovyan/test/test3.json' : `/home/${wslUsername}/test/test3.json`
    ];

    for (const filePath of testFiles) {
        log(`\nTesting with path: ${filePath}`);
        try {
            log('Writing file...');
            await writeFile(testContent, filePath);
            log('✅ Write successful');

            log('Reading file back...');
            const content = await readFileWSL(filePath);
            log('✅ Read successful');
            log(`Content: ${content}`);

            // Verify content
            const parsed = JSON.parse(content);
            const matches = parsed.metadata.createdBy === testContent.metadata.createdBy;
            log(`Content verification: ${matches ? '✅ Matches' : '❌ Different'}`);
        } catch (e) {
            log(`❌ Error with ${filePath}: ${e.message}`);
        }
    }

    // Test 3: Container Version Detection
    if (inContainer) {
        log('\n=== Testing Container Version Detection ===');
        try {
            const terminal = await vscode.window.createTerminal({
                name: 'Version Test',
                shellPath: '/bin/zsh',
                hideFromUser: true
            });
            
            const versionFile = '.rsm-version-test';
            terminal.sendText(`printf "%s" "$DOCKERHUB_VERSION" > ${versionFile} && exit`);
            await new Promise(resolve => setTimeout(resolve, 500));
            
            try {
                const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, versionFile);
                const content = await vscode.workspace.fs.readFile(uri);
                const version = Buffer.from(content).toString().trim();
                log(`Detected version: ${version}`);
                await vscode.workspace.fs.delete(uri);
            } catch (e) {
                log(`❌ Version detection failed: ${e.message}`);
            }
            terminal.dispose();
        } catch (e) {
            log(`❌ Container version test failed: ${e.message}`);
        }
    }

    log('\n=== Test Complete ===');
    vscode.window.showInformationMessage('Windows compatibility tests complete. Check Output for results.');
}

module.exports = {
    testWindowsCompatCommand
}; 