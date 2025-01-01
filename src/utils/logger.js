const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let outputChannel;
let logFile;

/**
 * Initialize the logger
 */
function initLogger() {
    outputChannel = vscode.window.createOutputChannel('RSM VS Code');

    // Create logs directory in the extension's workspace
    const logDir = path.join(os.homedir(), 'gh', 'rsm-vscode', 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    // Create log file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFile = path.join(logDir, `rsm-vscode-${timestamp}.log`);

    log(`Initializing logger. Writing to ${logFile}`);
}

/**
 * Log a message to both the output channel and file
 * @param {string} message - The message to log
 * @param {boolean} [show=false] - Whether to show the output channel
 */
function log(message, show = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    // Write to VS Code output channel
    if (outputChannel) {
        outputChannel.append(logMessage);
        if (show) {
            outputChannel.show();
        }
    }

    // Write to log file
    if (logFile) {
        fs.appendFileSync(logFile, logMessage);
    }
}

module.exports = {
    initLogger,
    log
}; 