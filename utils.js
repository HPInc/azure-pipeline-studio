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

    // In Windows-hosted VS Code with WSL workspaces, users often configure absolute
    // POSIX paths (e.g. /projects/templates). Convert those to UNC so fs/stat calls work.
    const wslSourcePath = [workspaceDir, documentDir].find(
        (value) => typeof value === 'string' && /^\\\\wsl\.localhost\\[^\\]+\\/i.test(value)
    );
    const wslMatch = typeof wslSourcePath === 'string' ? /^\\\\wsl\.localhost\\([^\\]+)\\/i.exec(wslSourcePath) : null;
    if (wslMatch && /^\/(?!\/)/.test(candidate)) {
        const uncPath = `\\\\wsl.localhost\\${wslMatch[1]}${candidate.replace(/\//g, '\\')}`;
        return path.normalize(uncPath);
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
