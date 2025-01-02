# Container Conflicts Check Functionality

This directory contains the code for the "RSM: Check Container Conflicts" feature that was part of the RSM VS Code extension. This feature helps prevent issues with multiple containers running with similar names.

## Files

- `checkContainerConflicts.js` - The main implementation of the container conflicts check functionality

## Integration Points

To integrate this functionality back into the extension:

1. Add the command to package.json:
```json
{
    "command": "rsm-vscode.checkContainerConflicts",
    "title": "RSM: Check Container Conflicts"
}
```

2. Register the command in extension.js:
```javascript
{
    command: 'rsm-vscode.checkContainerConflicts',
    handler: () => commands.checkContainerConflictsCommand(context)
}
```

## Required Dependencies

The functionality requires the following modules:
- vscode
- path
- os
- fs
- util
- child_process
- container-utils (internal)
- path-utils (internal)
- logger (internal)
- file-utils (internal)

## Functionality

The command:
1. Checks for the current workspace's .devcontainer.json
2. Extracts or creates a container name
3. Looks for running containers with similar names
4. Shows warnings if conflicts are found
5. Provides status messages about container state

This code is saved for reference to be reintegrated once the extension is working again. 