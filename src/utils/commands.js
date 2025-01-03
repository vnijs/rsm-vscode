const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { isWindows, isMacOS, isInContainer, windowsContainer, macosContainer, handleContainerConflict } = require('./container-utils');
const { windowsPaths, macosPaths } = require('./path-utils');
const { log } = require('./logger');
const { writeFile, getProjectName, createDevcontainerContent, createWorkspaceContent, createTemporaryDevContainer, cleanupTemporaryDevContainer } = require('./file-utils');
const { getWSLUsername } = require('./wsl-utils');
const { testFilePathsCommand } = require('./test-file-paths');
const { openWorkspaceFolder } = require('./workspace-utils');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { spawn } = require('child_process');
const { stopContainerIfNeeded } = require('./container-utils');
const { createConfigFiles } = require('./file-utils');
const { changeWorkspaceCommand } = require('./change-workspace');
const { startContainerCommand } = require('./start-container');
const { stopContainerCommand } = require('./stop-container');
const { setContainerVersionCommand } = require('./set-container-version');

// Get the appropriate utilities based on platform
const paths = isWindows ? windowsPaths : macosPaths;
const container = isWindows ? windowsContainer : macosContainer;

// Store the pending workspace change
let pendingWorkspaceChange = null;

async function startRadiantCommand() {
    // ... existing code ...
}

async function startGitGadgetCommand() {
    // ... existing code ...
}

async function cleanPackagesCommand() {
    // ... existing code ...
}

async function setupContainerCommand() {
    // ... existing code ...
}

async function debugEnvCommand() {
    // ... existing code ...
}

async function debugContainerCommand() {
    // ... existing code ...
}

async function checkContainerConflictsCommand(context) {
    // ... existing code ...
}

module.exports = {
    startContainerCommand,
    stopContainerCommand,
    startRadiantCommand,
    startGitGadgetCommand,
    cleanPackagesCommand,
    setupContainerCommand,
    debugEnvCommand,
    changeWorkspaceCommand,
    debugContainerCommand,
    setContainerVersionCommand,
    testFilePathsCommand,
    checkContainerConflictsCommand
};