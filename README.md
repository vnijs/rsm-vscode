# Rady Computing Environment for Business Analytics

VS Code extension for Rady School of Mangement computing enrivonment for Business Analytics. This extension simplifies the process of working with the computing enrivonment in Visual Studio Code on both macOS and Windows.

## Features

- **Container Management**
  - Attach to RSM containers with automatic platform detection (Windows/macOS, ARM/Intel)
  - Update container images to the latest version
  - Stop running containers
  - Handle container conflicts automatically

- **Development Tools**
  - Start Radiant server
  - Launch GitGadget
  - Clean package installations
  - Setup container environment

- **Workspace Management**
  - Change workspace folders
  - Set container versions
  - Debug container environment

## Requirements

- Visual Studio Code 1.85.0 or higher
- Docker Desktop installed and running
- Windows: WSL2 installed (for Windows users)
- macOS: Intel or Apple Silicon processor

## Installation

1. Install from VS Code Marketplace:
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for "Rady computing environment for business analytics"
   - Click Install

2. Required VS Code Extensions (automatically installed):
   - Remote - Containers
   - Remote Development Extension Pack

## Usage

The extension adds several commands to VS Code, accessible via the Command Palette (Ctrl+Shift+P):

- `RSM: Start Docker container` - Start the latest container version
- `RSM: Stop Docker container` - Stop running container
- `RSM: Start Radiant` - Launch Radiant server
- `RSM: Start GitGadget` - Launch GitGadget
- `RSM: Setup rsm-msba computing environment (setup)` - Intial setup
- `RSM: Update docker image` - Update to the latest container version
- `RSM: Uninstall Update docker image` - Update to the latest container version

<!-- - `RSM: Change workspace folder` - Switch workspace location -->
<!-- - `RSM: Set Container Version` - Change container version -->
<!-- - `RSM: Attach to Container` - Start and attach to an RSM container
- `RSM: Detach from Container` - Stop and detach from the current container -->

## Extension Settings

This extension contributes the following settings:

- `workbench.welcomePage.walkthroughs.openOnInstall`: Disabled by default
- `remote.containers.defaultExtensions`: Configured for container development
- `workspace.openFolderWhenFileOpens`: Enabled for better workspace handling
- `remote.autoForwardPorts`: Enabled for automatic port forwarding

## Known Issues

See our [GitHub issues page](https://github.com/vnijs/rsm-vscode/issues) for current known issues.

## Release Notes

### 0.5.0

Initial release:
- Basic container management
- Development tool integration
- Workspace handling
- Platform-specific support (Windows/macOS)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License - see the LICENSE file for details.