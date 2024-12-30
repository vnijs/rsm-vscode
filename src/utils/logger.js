const vscode = require('vscode');

let outputChannel;

/**
 * Initializes the logger with a VS Code output channel
 * @param {vscode.ExtensionContext} context The extension context
 */
function initLogger(context) {
    outputChannel = vscode.window.createOutputChannel('RSM VS Code');
    context.subscriptions.push(outputChannel);
}

/**
 * Logs a message to the output channel and optionally shows a popup
 * @param {string} message The message to log
 * @param {boolean} popup Whether to show the message in a popup
 */
function log(message, popup = false) {
    if (!outputChannel) return;  // Guard against early calls
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    outputChannel.appendLine(logMessage);
    if (popup) {
        vscode.window.showInformationMessage(message);
    }
}

/**
 * Shows the output channel
 */
function showOutput() {
    if (outputChannel) {
        outputChannel.show();
    }
}

module.exports = {
    initLogger,
    log,
    showOutput
}; 