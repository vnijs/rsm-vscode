/**
 * Container Conflicts Check Functionality
 * This code was part of the RSM VS Code extension
 * Saved for future reference
 */

// Command registration in package.json:
/*
{
    "command": "rsm-vscode.checkContainerConflicts",
    "title": "RSM: Check Container Conflicts"
}
*/

// Command registration in extension.js:
/*
{
    command: 'rsm-vscode.checkContainerConflicts',
    handler: () => commands.checkContainerConflictsCommand(context)
}
*/

// Main implementation from commands.js:
async function checkContainerConflictsCommand(context) {
    try {
        log('Starting checkContainerConflictsCommand');
        log(`Context received: ${context ? 'yes' : 'no'}`);

        // Get current workspace folder
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        log(`Current folder: ${currentFolder ? currentFolder.uri.fsPath : 'none'}`);

        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        const folderPath = currentFolder.uri.fsPath;
        const devContainerFile = path.join(folderPath, '.devcontainer.json');
        log(`Looking for devcontainer file at: ${devContainerFile}`);

        // Get or create devcontainer content
        let containerName;
        try {
            const devContainerRaw = await fs.promises.readFile(devContainerFile, 'utf8');
            const devContainerContent = JSON.parse(devContainerRaw);
            containerName = devContainerContent.name;
            log(`Found container name in .devcontainer.json: ${containerName}`);
        } catch (e) {
            log(`Error reading .devcontainer.json: ${e.message}`);
            log('No .devcontainer.json found, creating default configuration');
            const isArm = os.arch() === 'arm64';
            log(`Architecture is ARM: ${isArm}`);
            const composeFile = container.getComposeFile(isArm, context);
            log(`Compose file path: ${composeFile}`);
            const wslComposeFile = paths.toWSLMountPath(composeFile);
            log(`WSL compose file path: ${wslComposeFile}`);
            const devContainerContent = await createDevcontainerContent(folderPath, wslComposeFile, isArm);
            containerName = devContainerContent.name;
            log(`Created default container name: ${containerName}`);
        }

        // Get base name (everything before the version suffix)
        const baseName = containerName.split('-').slice(0, -1).join('-');
        log(`Base container name: ${baseName}`);

        // Check for running containers only
        log('Checking for running containers...');
        const { stdout: containerList } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}"');
        log(`Docker ps output: ${containerList}`);

        const runningContainers = containerList.split('\n')
            .filter(line => line.startsWith(baseName))
            .map(line => {
                const [name, ...statusParts] = line.split('\t');
                return { name, status: statusParts.join('\t') };
            })
            .filter(Boolean);

        log('Running containers:');
        log(JSON.stringify(runningContainers, null, 2));

        // Check for conflicts
        const conflicts = runningContainers.filter(c => c.name !== containerName);
        log(`Found ${conflicts.length} conflicts`);

        if (conflicts.length > 0) {
            const msg = `Container conflict detected!\n\nTrying to create/attach: ${containerName}\nRunning containers with similar name:\n${conflicts.map(c => `- ${c.name} (${c.status})`).join('\n')}`;
            log(msg);
            vscode.window.showWarningMessage(msg, { modal: true });
        } else if (runningContainers.length > 0) {
            const msg = `No conflicts. Found exact match: ${runningContainers[0].name} (${runningContainers[0].status})`;
            log(msg);
            vscode.window.showInformationMessage(msg, { modal: true });
        } else {
            const msg = 'No running containers found with similar names. Safe to create new container.';
            log(msg);
            vscode.window.showInformationMessage(msg, { modal: true });
        }
    } catch (error) {
        log(`Error in checkContainerConflictsCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to check container conflicts: ${error.message}`);
    }
}

// Required imports and dependencies:
/*
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const { container } = require('./container-utils');
const { paths } = require('./path-utils');
const { log } = require('./logger');
const { createDevcontainerContent } = require('./file-utils');
*/ 