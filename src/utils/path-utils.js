const os = require('os');
const { getDefaultDistro, getWSLUsername } = require('./wsl-utils');

const windowsPaths = {
    toContainerPath(wslPath) {
        const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
        if (match) {
            return `/home/jovyan/${match[2]}`;
        }
        return wslPath;
    },

    toWSLPath(wslPath) {
        const match = wslPath.match(/\\\\wsl\.localhost\\[^\\]+\\home\\([^\\]+)\\(.+)/);
        if (match) {
            return `/home/${match[1]}/${match[2]}`;
        }
        return wslPath;
    },

    async toLocalPath(containerPath) {
        if (containerPath.startsWith('/home/jovyan/')) {
            const relativePath = containerPath.replace('/home/jovyan/', '');
            const [distro, username] = await Promise.all([getDefaultDistro(), getWSLUsername()]);
            return `\\\\wsl.localhost\\${distro}\\home\\${username}\\${relativePath}`;
        }
        return containerPath;
    },

    toWSLMountPath(winPath) {
        return winPath
            .replace(/^([A-Za-z]):/, '/mnt/$1')
            .replace(/\\/g, '/')
            .toLowerCase();
    },

    isWSLPath(path) {
        return path.startsWith('\\\\wsl.localhost\\');
    }
};

const macosPaths = {
    toContainerPath(localPath) {
        // Use os.homedir() consistently for path conversion
        return localPath.replace(os.homedir(), '/home/jovyan');
    },

    toLocalPath(containerPath) {
        // Use os.homedir() consistently for path conversion
        return containerPath.replace('/home/jovyan', os.homedir());
    },

    // Remove extra read/write/pathExists methods since they're not needed
    // The core functionality is just path conversion

    toWSLMountPath(path) {
        return path; // No conversion needed on macOS
    },

    isWSLPath() {
        return false; // macOS never has WSL paths
    }
};

module.exports = {
    windowsPaths,
    macosPaths
};