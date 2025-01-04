const vscode = require('vscode');
const { isWindows, isMacOS, isInContainer, getContainerVersion } = require('./container-utils');
const { log } = require('./logger');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');

async function updateContainerCommand(context) {
    try {
        // Determine platform and architecture
        const isArm = os.arch() === 'arm64';
        const platform = isWindows ? 'windows' : (isMacOS ? 'macos' : 'linux');
        const architecture = isArm ? 'arm' : 'intel';
        const imageName = `vnijs/rsm-msba-k8s-${architecture}:latest`;

        // Check if we're in a container and get current version
        const inContainer = await isInContainer();
        const currentVersion = await getContainerVersion();
        log(`Current state - In container: ${inContainer}, Version: ${currentVersion}`);

        // If in container with 'latest' version, prompt to detach
        if (inContainer && currentVersion === 'latest') {
            const choice = await vscode.window.showWarningMessage(
                'You need to detach from the current container to update.',
                'Detach and Update',
                'Cancel'
            );

            if (choice !== 'Detach and Update') {
                log('User cancelled detach and update');
                return;
            }

            // Execute detach command
            await vscode.commands.executeCommand('rsm-vscode.stopContainer');
            // Wait a moment for the container to stop
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Check if latest image is already pulled
        const { stdout: currentDigest } = await execAsync(`docker images --no-trunc --quiet ${imageName}`);

        // Pull latest without showing version selection
        log(`Checking for updates to image: ${imageName}`);

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Checking for RSM container updates (${platform}, ${architecture})`,
            cancellable: true
        }, async (progress, token) => {
            try {
                // Pull the latest image
                progress.report({ message: 'Checking for updates...' });
                const { stdout: pullOutput, stderr: pullError } = await execAsync(`docker pull ${imageName}`);
                log(`Pull output: ${pullOutput}`);
                if (pullError) log(`Pull stderr: ${pullError}`);

                // Get new digest
                const { stdout: newDigest } = await execAsync(`docker images --no-trunc --quiet ${imageName}`);

                // If digests match, no update was needed
                if (currentDigest.trim() === newDigest.trim()) {
                    vscode.window.showInformationMessage('Container image is already up to date');
                    return;
                }

                // Remove old containers using this image
                progress.report({ message: 'Cleaning up old containers...' });
                try {
                    const { stdout: containers } = await execAsync(`docker ps -a --filter ancestor=${imageName} --format "{{.Names}}"`);
                    if (containers) {
                        const containerList = containers.split('\n').filter(c => c);
                        for (const container of containerList) {
                            await execAsync(`docker rm -f ${container}`);
                            log(`Removed container: ${container}`);
                        }
                    }
                } catch (cleanupError) {
                    log(`Cleanup error: ${cleanupError.message}`);
                }

                // Remove old images
                progress.report({ message: 'Removing old images...' });
                try {
                    await execAsync(`docker image prune -f --filter "label=org.opencontainers.image.ref.name=rsm-msba"`);
                } catch (pruneError) {
                    log(`Prune error: ${pruneError.message}`);
                }

                vscode.window.showInformationMessage('Successfully updated RSM container image');
            } catch (error) {
                log(`Error during update: ${error.message}`);
                vscode.window.showErrorMessage(`Failed to update container: ${error.message}`);
                throw error;
            }
        });
    } catch (error) {
        log(`Update container error: ${error.message}`);
        vscode.window.showErrorMessage(`Failed to update container: ${error.message}`);
    }
}

module.exports = {
    updateContainerCommand
}; 