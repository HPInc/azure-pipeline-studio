const os = require('os');
const path = require('path');

/**
 * Pick the first non-empty string from the provided values
 * @param {...string} values - Values to check
 * @returns {string|undefined} The first non-empty string or undefined
 */
function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length) {
            return value;
        }
    }
    return undefined;
}

/**
 * Resolve a configured path with variable substitution
 * @param {string} rawPath - The raw path string
 * @param {string} workspaceDir - The workspace directory
 * @param {string} documentDir - The document directory
 * @returns {string|undefined} The resolved path or undefined
 */
function resolveConfiguredPath(rawPath, workspaceDir, documentDir) {
    if (typeof rawPath !== 'string') {
        return undefined;
    }

    let candidate = rawPath.trim();
    if (!candidate.length) {
        return undefined;
    }

    const homeDir = os.homedir();
    candidate = candidate.replace(/^~(?=$|[\/])/, homeDir);

    candidate = candidate.replace(/\$\{workspaceFolder\}/g, workspaceDir || '');
    candidate = candidate.replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] || '');
    candidate = candidate.replace(/\$\{([^}]+)\}/g, (match, name) => {
        if (name === 'workspaceFolder') {
            return workspaceDir || '';
        }
        return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : match;
    });

    // A Windows-style path (C:\...) isn't recognized by path.isAbsolute() under WSL/Linux (POSIX
    // semantics), so without this it gets silently concatenated onto workspaceDir/documentDir
    // instead of used as-is (e.g. a resource location configured on native Windows but resolved
    // while running the extension host under Remote-WSL). Translate it to its WSL mount path first.
    if (path.sep === '/') {
        const winMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(candidate);
        if (winMatch) {
            candidate = `/mnt/${winMatch[1].toLowerCase()}/${winMatch[2].replace(/\\/g, '/')}`;
        }
    }

    // A POSIX-absolute path (e.g. a linuxPath resource location) isn't recognized as rooted by
    // native Windows: path.isAbsolute()/normalize() silently anchor it to the current drive
    // (C:\root\...) instead of failing, pointing at a non-existent location. This happens when
    // native Windows VS Code browses a WSL filesystem via \\wsl.localhost\<distro>\ and the
    // active document/workspace lives there. Reattach that distro's UNC prefix so the path
    // actually resolves to the WSL filesystem it was configured against.
    if (path.sep === '\\' && /^\//.test(candidate)) {
        const wslRootMatch = [workspaceDir, documentDir]
            .map((value) => /^(\\\\wsl(?:\.localhost|\$)\\[^\\]+)(?:\\|$)/i.exec(String(value || '')))
            .find(Boolean);
        if (wslRootMatch) {
            candidate = `${wslRootMatch[1]}${candidate.replace(/\//g, '\\')}`;
        }
    }

    if (path.isAbsolute(candidate)) {
        return path.normalize(candidate);
    }

    if (workspaceDir) {
        return path.normalize(path.resolve(workspaceDir, candidate));
    }

    if (documentDir) {
        return path.normalize(path.resolve(documentDir, candidate));
    }

    return path.normalize(path.resolve(process.cwd(), candidate));
}

/**
 * Normalize a file extension
 * @param {string} ext - The file extension
 * @returns {string|undefined} The normalized extension or undefined
 */
function normalizeExtension(ext) {
    if (typeof ext !== 'string') return undefined;
    const value = ext.trim().toLowerCase();
    if (!value) return undefined;
    return value.startsWith('.') ? value : `.${value}`;
}

module.exports = {
    pickFirstString,
    resolveConfiguredPath,
    normalizeExtension,
};
