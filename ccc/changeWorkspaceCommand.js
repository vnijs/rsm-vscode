// Current implementation of changeWorkspaceCommand with container conflict checks
async function changeWorkspaceCommand(context) {
    if (!(await isInContainer())) {
        // If not in container, just show file browser
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select New Workspace Folder'
        });

        if (result && result[0]) {
            await vscode.commands.executeCommand('vscode.openFolder', result[0], { forceReuseWindow: true });
        }
        return;
    }

    try {
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            throw new Error('No workspace folder found');
        }

        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: currentFolder.uri,
            title: 'Select New Workspace Folder'
        });

        if (!result || !result[0]) {
            log('No folder selected');
            return;
        }

        const newPath = result[0].fsPath.replace(/\\/g, '/');
        log(`Selected new workspace path: ${newPath}`);

        // Check for container conflicts
        const targetDevContainerFile = path.join(newPath, '.devcontainer.json');
        let targetContainerName;
        try {
            const devContainerRaw = await fs.promises.readFile(targetDevContainerFile, 'utf8');
            const devContainerContent = JSON.parse(devContainerRaw);
            targetContainerName = devContainerContent.name;
            log(`Target container name: ${targetContainerName}`);
        } catch (e) {
            log(`No .devcontainer.json found in target, using default configuration`);
            targetContainerName = 'rsm-msba-k8s-latest';
            log(`Using default container name: ${targetContainerName}`);

            // Create our standard configuration files first
            await createConfigFiles(newPath);
            log('Created standard configuration files');

            // If we're already in a "latest" container, we can just switch
            const { stdout: currentContainer } = await execAsync('docker ps --format "{{.Names}}" --filter status=running --filter name=rsm-msba-k8s-latest');
            if (currentContainer.trim()) {
                log('Currently in latest container, proceeding with switch');
                const uri = await container.openInContainer(newPath);
                log(`Opening with URI: ${uri.toString()}`);
                await openWorkspaceFolder(uri);
                return;
            }
        }

        // Check for running containers
        const { stdout: containerList } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}"');
        const runningContainers = containerList.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [name, ...statusParts] = line.split('\t');
                return { name, status: statusParts.join('\t') };
            })
            .filter(c => c.name.startsWith('rsm-msba-k8s-'));

        // If target container is already running, that's fine
        const targetIsRunning = runningContainers.some(c => c.name === targetContainerName);
        if (targetIsRunning) {
            log(`Target container ${targetContainerName} is already running`);
            pendingWorkspaceChange = newPath;
            // Use our existing stop container command
            await stopContainerCommand(context);
            return;
        }

        // Check for conflicts
        const conflicts = runningContainers.filter(c => c.name !== targetContainerName);
        if (conflicts.length > 0) {
            const msg = `Container conflict detected!\n\nTrying to switch to: ${targetContainerName}\nCurrently running:\n${conflicts.map(c => `- ${c.name} (${c.status})`).join('\n')}`;
            log(msg);

            const detachAndStopButton = 'Detach, Stop Container, and Switch';
            const response = await vscode.window.showWarningMessage(
                msg,
                { modal: true, detail: 'This will detach from the current container and stop any conflicting containers.' },
                detachAndStopButton
            );

            if (response === detachAndStopButton) {
                log('User chose to detach and stop containers');
                pendingWorkspaceChange = newPath;

                // Store current workspace path before detaching
                await context.globalState.update('lastWorkspaceFolder', currentFolder.uri.fsPath);

                // Use our existing stop container command
                await stopContainerCommand(context);

                // Then stop any other conflicting containers
                for (const container of conflicts) {
                    try {
                        log(`Stopping container: ${container.name}`);
                        await execAsync(`docker stop ${container.name}`);
                        log(`Successfully stopped container: ${container.name}`);
                    } catch (error) {
                        log(`Error stopping container ${container.name}: ${error.message}`);
                        throw new Error(`Failed to stop container ${container.name}: ${error.message}`);
                    }
                }
                return;
            } else {
                log('User cancelled workspace change due to conflicts');
                vscode.window.showInformationMessage('Workspace change cancelled. Conflicting containers are still running.');
                return;
            }
        }

        // No conflicts, proceed with change
        log('No conflicts found, proceeding with workspace change');
        pendingWorkspaceChange = newPath;
        await stopContainerCommand(context);

    } catch (error) {
        log(`Error in changeWorkspaceCommand: ${error.message}`);
        if (error.stack) {
            log(`Error stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(`Failed to change workspace: ${error.message}`);
    }
} 