const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hash = value => createHash('sha256').update(value).digest('hex');
const counters = { hits: 0, compiled: 0 };
const engine = hash(fs.readFileSync(__filename));

function projectCache(cwd = process.cwd()) {
    let namespace;
    try { namespace = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name; } catch {}
    namespace ||= fs.realpathSync(cwd);
    return process.env.BIMBA_CACHE_DIR || path.join(os.homedir(), '.cache', 'bimba', 'projects', hash(namespace).slice(0, 24));
}

function atomicWrite(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, contents);
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function atomicJSON(file, value) { atomicWrite(file, JSON.stringify(value)); }

function compilerEnvironment(sources) {
    const names = new Set(sources.flatMap(source => [...source.matchAll(/\$(\w+)\$/g)].map(match => match[1].toUpperCase())));
    return Object.fromEntries([...names].sort().map(name => [name, process.env[name] ?? null]));
}

// Both browser output and virtual TypeScript use one checksummed, atomic store.
// Callers own the compilation contract and select the fields they can restore.
class CompilationStore {
    constructor(directory, force = false) {
        this.directory = directory;
        this.force = force;
        this.stats = { hits: 0, compiled: 0 };
    }
    read(slot, key, valid) {
        if (!this.force && process.env.BIMBA_FORCE !== '1') {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(this.directory, slot + '.json'), 'utf8'));
                if (value?.format === 2 && value.output && typeof value.output === 'object' && value.key === hash(engine + key)
                    && value.digest === hash(JSON.stringify(value.output)) && valid(value.output)) {
                    this.stats.hits++; counters.hits++;
                    return value.output;
                }
            } catch (error) {
                if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
            }
        }
        this.stats.compiled++; counters.compiled++;
        return null;
    }
    write(slot, key, output) {
        atomicJSON(path.join(this.directory, slot + '.json'), {
            format: 2, key: hash(engine + key), output, digest: hash(JSON.stringify(output)),
        });
    }
}

module.exports = { CompilationStore, hash, counters, projectCache, atomicJSON, atomicWrite, compilerEnvironment };
