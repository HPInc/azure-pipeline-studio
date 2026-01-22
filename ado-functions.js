// Azure DevOps expression functions
// Pattern similar to terraform.js - plain object export for simple integration

function returnBoolean(value) {
    return value ? '__TRUE__' : '__FALSE__';
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const l = value.toLowerCase();
        if (l === '__true__' || l === 'true') return true;
        if (l === '__false__' || l === 'false' || l.length === 0) return false;
    }
    return Boolean(value);
}

function compareValues(left, right) {
    const normalize = (input) => {
        if (input === undefined || input === null) return '';
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (trimmed.length === 0) return '';
            const lowered = trimmed.toLowerCase();
            if (lowered === 'true' || lowered === '__true__') return true;
            if (lowered === 'false' || lowered === '__false__') return false;
            if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
            return trimmed;
        }
        return input;
    };
    const a = normalize(left);
    const b = normalize(right);
    if (a === b) return 0;
    if (typeof a === typeof b && (typeof a === 'number' || typeof a === 'boolean')) return a > b ? 1 : -1;
    const aStr = String(a);
    const bStr = String(b);
    if (aStr === bStr) return 0;
    return aStr > bStr ? 1 : -1;
}

function containsHelper(container, value) {
    if (typeof container === 'string') return typeof value === 'string' ? container.includes(value) : false;
    if (Array.isArray(container)) return container.some((item) => compareValues(item, value) === 0);
    if (container && typeof container === 'object') return Object.prototype.hasOwnProperty.call(container, value);
    return false;
}

function containsValueHelper(container, value) {
    if (Array.isArray(container)) return container.some((item) => compareValues(item, value) === 0);
    if (container && typeof container === 'object')
        return Object.values(container).some((item) => compareValues(item, value) === 0);
    return false;
}

function startsWithHelper(str, prefix) {
    if (typeof str !== 'string' || typeof prefix !== 'string') return false;
    return str.toLowerCase().startsWith(prefix.toLowerCase());
}

function endsWithHelper(str, suffix) {
    if (typeof str !== 'string' || typeof suffix !== 'string') return false;
    return str.toLowerCase().endsWith(suffix.toLowerCase());
}

function replaceString(str, search, replacement) {
    if (typeof str !== 'string') return str;
    if (typeof search !== 'string') search = String(search);
    if (typeof replacement !== 'string') replacement = String(replacement);
    return str.split(search).join(replacement);
}

function splitString(str, delimiter) {
    if (typeof str !== 'string') return [str];
    if (typeof delimiter !== 'string') delimiter = String(delimiter);
    return str.split(delimiter);
}

function joinArray(separator, array) {
    if (!Array.isArray(array)) return typeof array === 'string' ? array : String(array);
    if (typeof separator !== 'string') separator = String(separator);
    return array
        .map((item) => {
            if (item === null || item === undefined) return '';
            if (typeof item === 'object') return '';
            return String(item);
        })
        .join(separator);
}

function formatString(args) {
    if (!args || args.length === 0) return '';
    let format = String(args[0]);
    const values = args.slice(1);
    format = format.replace(/\{(\d+)(?::([^}]+))?\}/g, (m, index, formatSpec) => {
        const idx = parseInt(index, 10);
        if (idx >= values.length) return m;
        let value = values[idx];
        if (formatSpec && value instanceof Date) {
            return formatDateTime(value, formatSpec);
        }
        if (value === null || value === undefined) return '';
        return String(value);
    });
    format = format.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
    return format;
}

function formatDateTime(date, formatSpec) {
    const pad = (num, size = 2) => String(num).padStart(size, '0');
    return formatSpec
        .replace(/yyyy/g, date.getFullYear())
        .replace(/yy/g, String(date.getFullYear()).slice(-2))
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/M/g, date.getMonth() + 1)
        .replace(/dd/g, pad(date.getDate()))
        .replace(/d/g, date.getDate())
        .replace(/HH/g, pad(date.getHours()))
        .replace(/H/g, date.getHours())
        .replace(/mm/g, pad(date.getMinutes()))
        .replace(/m/g, date.getMinutes())
        .replace(/ss/g, pad(date.getSeconds()))
        .replace(/s/g, date.getSeconds())
        .replace(/ffff/g, pad(date.getMilliseconds(), 4))
        .replace(/ff/g, pad(Math.floor(date.getMilliseconds() / 10)))
        .replace(/f/g, Math.floor(date.getMilliseconds() / 100));
}

function convertToJsonHelper(value) {
    if (value === undefined) return 'null';
    try {
        return JSON.stringify(
            value,
            (k, v) => {
                if (typeof v === 'boolean') return v ? 'True' : 'False';
                if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
                return v;
            },
            2
        );
    } catch (e) {
        return String(value);
    }
}

const _counters = new Map();
function counter(prefix, seed) {
    const key = String(prefix || '');
    const seedValue = typeof seed === 'number' ? seed : parseInt(seed, 10) || 0;
    if (!_counters.has(key)) _counters.set(key, seedValue);
    const current = _counters.get(key);
    _counters.set(key, current + 1);
    return current;
}

// Comparison functions
function eq(args) {
    return returnBoolean(compareValues(args[0], args[1]) === 0);
}

function ne(args) {
    return returnBoolean(compareValues(args[0], args[1]) !== 0);
}

function gt(args) {
    return returnBoolean(compareValues(args[0], args[1]) > 0);
}

function ge(args) {
    return returnBoolean(compareValues(args[0], args[1]) >= 0);
}

function lt(args) {
    return returnBoolean(compareValues(args[0], args[1]) < 0);
}

function le(args) {
    return returnBoolean(compareValues(args[0], args[1]) <= 0);
}

// Logical functions
function and(args) {
    return returnBoolean((args || []).every((a) => toBoolean(a)));
}

function or(args) {
    return returnBoolean((args || []).some((a) => toBoolean(a)));
}

function not(args) {
    return returnBoolean(!toBoolean(args[0]));
}

function xor(args) {
    return returnBoolean(toBoolean(args[0]) !== toBoolean(args[1]));
}

// Collection functions
function coalesce(args) {
    return (args || []).find((arg) => arg !== undefined && arg !== null && arg !== '');
}

function containsFn(args) {
    return returnBoolean(containsHelper(args[0], args[1]));
}

function containsValue(args) {
    return returnBoolean(containsValueHelper(args[0], args[1]));
}

function inFn(args) {
    return returnBoolean((args || []).slice(1).some((candidate) => compareValues(args[0], candidate) === 0));
}

function notIn(args) {
    return returnBoolean(!(args || []).slice(1).some((candidate) => compareValues(args[0], candidate) === 0));
}

// String functions
function lower(args) {
    return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
}

function upper(args) {
    return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0];
}

function startsWith(args) {
    return returnBoolean(startsWithHelper(args[0], args[1]));
}

function endsWith(args) {
    return returnBoolean(endsWithHelper(args[0], args[1]));
}

function trim(args) {
    return typeof args[0] === 'string' ? args[0].trim() : args[0];
}

function replace(args) {
    return replaceString(args[0], args[1], args[2]);
}

function split(args) {
    return splitString(args[0], args[1]);
}

function join(args) {
    return joinArray(args[0], args[1]);
}

function format(args) {
    return formatString(args);
}

// Utility functions
function length(args) {
    if (typeof args[0] === 'string' || Array.isArray(args[0])) return args[0].length;
    if (args[0] && typeof args[0] === 'object') return Object.keys(args[0]).length;
    return 0;
}

function convertToJson(args) {
    return convertToJsonHelper(args[0]);
}

function counterFn(args) {
    return counter(args[0], args[1]);
}

function iif(args) {
    return toBoolean(args[0]) ? args[1] : args[2];
}

function ifFn(args) {
    return toBoolean(args[0]) ? args[1] : args[2];
}

function elseif(args) {
    // elseif works like a chained conditional
    // First arg is condition, second is value if true, third is the else/elseif continuation
    return toBoolean(args[0]) ? args[1] : args[2];
}

// Status functions
function always(args) {
    return returnBoolean(true);
}

function canceled(args) {
    return returnBoolean(false);
}

function failed(args) {
    return returnBoolean(false);
}

function succeeded(args) {
    return returnBoolean(true);
}

function succeededOrFailed(args) {
    return returnBoolean(true);
}

const ExpressionFunctions = {
    // Helper functions (for internal use)
    returnBoolean,
    toBoolean,

    // Azure DevOps expression functions (camelCase names)
    // Comparison
    eq,
    ne,
    gt,
    ge,
    lt,
    le,
    // Logical
    and,
    or,
    not,
    xor,
    // Collection
    coalesce,
    contains: containsFn,
    containsValue,
    in: inFn,
    notIn,
    // String
    lower,
    upper,
    startsWith,
    endsWith,
    trim,
    replace,
    split,
    join,
    format,
    // Utility
    length,
    convertToJson,
    counter: counterFn,
    // Conditional
    iif,
    if: ifFn,
    elseif,
    // Status
    always,
    canceled,
    failed,
    succeeded,
    succeededOrFailed,
};

module.exports = ExpressionFunctions;
