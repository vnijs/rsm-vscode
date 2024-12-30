const vscode = require('vscode');
const commands = require('./utils/commands');

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'rsm-vscode.startContainer',
            () => commands.startContainerCommand(context)
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.stopContainer',
            () => commands.stopContainerCommand(context)
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.startRadiant',
            () => commands.startRadiantCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.startGitGadget',
            () => commands.startGitGadgetCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.cleanPackages',
            () => commands.cleanPackagesCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.setupContainer',
            () => commands.setupContainerCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.debugEnv',
            () => commands.debugEnvCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.changeWorkspace',
            () => commands.changeWorkspaceCommand(context)
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.debugContainer',
            () => commands.debugContainerCommand()
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.setContainerVersion',
            () => commands.setContainerVersionCommand(context)
        ),
        vscode.commands.registerCommand(
            'rsm-vscode.testFilePaths',
            () => commands.testFilePathsCommand()
        )
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}; 