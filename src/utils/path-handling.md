# Path Handling in Different Environments

## Windows-Specific Path Handling with docker running through WSL2

## When Not Connected to Container (in WSL)

### Working Paths for Reading
- Direct WSL path: `/home/username/path/file.txt`
  - Example: `/home/vnijs/test3/test-file-to-read.txt` ✅
- Windows path through WSL: `/mnt/c/Users/username/file.txt`
  - Example: `/mnt/c/Users/vnijs/test-file-to-read-win.txt` ✅
  - Note that this is on the Windows file system, not the WSL file system.

### Working Paths for Writing
- Direct WSL path: `/home/username/path/file.txt`
  - Example: `/home/vnijs/test3/test4.txt` ✅
- Windows path through WSL: `/mnt/c/Users/username/file.txt`
  - Example: `/mnt/c/Users/vnijs/test7.txt` ✅
  - Note that this is on the Windows file system, not the WSL file system.

### Non-Working Paths
- Windows-style WSL paths: `\\wsl.localhost\distro\path` ❌
- Direct Windows paths: `C:\Users\username\file.txt` ❌
- Paths with @ symbol: `@\\wsl.localhost\...` ❌
- Backslash paths: `\home\username\path` ❌

## When Connected to Container

### Working Paths for Reading
- Direct WSL path: `/home/username/path/file.txt`
  - Example: `/home/vnijs/test3/test-file-to-read.txt` ✅
- Windows path through WSL: `/mnt/c/Users/username/file.txt`
  - Example: `/mnt/c/Users/vnijs/test-file-to-read-win.txt` ✅
  - Note that this is on the Windows file system, not the WSL file system.

### Working Paths for Writing
- Direct WSL path: `/home/username/path/file.txt`
  - Example: `/home/vnijs/test3/test4.txt` ✅
- Windows path through WSL: `/mnt/c/Users/username/file.txt`
  - Example: `/mnt/c/Users/vnijs/test7.txt` ✅

### Content Verification Issue
- When reading back written content, extra quotes are added
  - Written: `"test content"`
  - Read back: `""test content""`
  - This causes content verification to fail even though writing succeeds

### Best Practices for Windows
  #### Path Format Rules
  1. Always use forward slashes for WSL paths
  2. Use `/mnt/c/` format for accessing Windows files
  3. Use direct WSL paths (`/home/username/...`) for WSL files
  4. Avoid Windows-style paths with backslashes
  5. Avoid `\\wsl.localhost\` format paths

  #### Path Conversion
  - Windows to WSL: Replace `C:\` with `/mnt/c/`
  - WSL to Windows: Replace `/mnt/c/` with `C:\`
  - Container to WSL: Replace `/home/jovyan` with `/home/username`

  #### Environment Detection
  - Container: `vscode.env.remoteName === 'dev-container'`
  - WSL: Check for WSL paths and use appropriate commands
  - Always check environment before path operations

### Common Issues
  1. Avoid relative paths
  2. Ensure correct WSL distribution name
  3. Handle extra quotes in read content
  4. Use appropriate path format for the current environment
  5. In container, defaultDistro is not available (use hardcoded value)

## macOS-Specific Path Handling

### Working Paths for Reading
- Direct paths: `/Users/username/path/file.txt`
  - Example: `/Users/vnijs/test3/test-file-to-read.txt` ✅
- Container paths: `/home/jovyan/path/file.txt`
  - Example: `/home/jovyan/test3/test-file-to-read.txt` ✅

### Working Paths for Writing
- Direct paths: `/Users/username/path/file.txt`
  - Example: `/Users/vnijs/test3/test4.txt` ✅
- Container paths: `/home/jovyan/path/file.txt`
  - Example: `/home/jovyan/test3/test4.txt` ✅

### Path Conversion
- Host to Container: Replace `/Users/username` with `/home/jovyan`
- Container to Host: Replace `/home/jovyan` with `/Users/username`

### Best Practices for macOS
1. Use os.homedir() for getting user home directory
2. Always use forward slashes (native to macOS)
3. Keep paths consistent between host and container
4. Handle file permissions appropriately

