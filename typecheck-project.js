import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const extensions = [{ extension: '.imba', isMixedContent: false, scriptKind: 7 }];
const manifests = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', '.pnp.cjs', '.pnp.data.json'];
const equal = (left, right) => left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
const read = (file, encoding = 'utf8') => {
    try { return fs.readFileSync(file, encoding); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
};

// Disk state belongs to the project, independently of tsserver's open buffers.
// Parse includes/excludes/extends with this project's TypeScript, not a second glob implementation.
export class TypecheckProject {
    constructor(cwd, tsserver) {
        this.cwd = cwd;
        this.ts = createRequire(tsserver)('./typescript.js');
        this.known = new Set();
        this.sources = new Map();
        this.configuration = null;
        this.dependencies = null;
        this.members = null;
    }

    capture(selected) {
        const ts = this.ts;
        const configuration = new Map();
        const members = new Map();
        const configs = new Set();
        const directories = new Set([this.cwd]);
        const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {}, readFile: file => {
            const text = read(file);
            configuration.set(file, text);
            return text ?? undefined;
        } };
        const visit = file => {
            file = path.resolve(file);
            if (configs.has(file)) return;
            configs.add(file);
            directories.add(path.dirname(file));
            const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host, undefined, undefined, extensions);
            for (const source of parsed?.fileNames || []) members.set(source, true);
            for (const reference of parsed?.projectReferences || []) visit(ts.resolveProjectReferencePath(reference));
        };
        for (const file of [...selected.keys(), path.join(this.cwd, '__bimba_project__')]) {
            let directory = path.dirname(file);
            while (true) {
                const config = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(directory, name)).find(fs.existsSync);
                if (config) { visit(config); break; }
                const parent = path.dirname(directory);
                if (parent === directory) break;
                directory = parent;
            }
        }
        const sources = new Map();
        for (const file of new Set([...members.keys(), ...selected.keys(), ...this.known])) {
            const content = selected.has(file) ? selected.get(file) : read(file);
            if (content !== null) sources.set(file, content);
            else this.known.delete(file);
        }
        const dependencies = this.dependencyState(sources.keys(), directories);
        return { sources, configuration, dependencies, members };
    }

    dependencyState(files, directories = new Set([this.cwd])) {
        const state = new Map();
        const filenames = [...files];
        const resolutionRoots = new Set();
        for (const directory of directories) {
            let current = directory;
            while (!resolutionRoots.has(current)) {
                resolutionRoots.add(current);
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
        }
        for (const directory of resolutionRoots) {
            for (const name of manifests) {
                const file = path.join(directory, name);
                state.set(file, read(file, name.endsWith('.lockb') ? 'base64' : 'utf8'));
            }
            const modules = path.join(directory, 'node_modules');
            let names;
            try { names = fs.readdirSync(modules).filter(name => !name.startsWith('.')).sort(); }
            catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
            const packages = [];
            for (const name of names) {
                const entry = path.join(modules, name);
                if (name.startsWith('@')) {
                    for (const scoped of fs.readdirSync(entry).sort()) packages.push(path.join(entry, scoped));
                } else packages.push(entry);
            }
            state.set(modules, JSON.stringify(packages.map(entry => {
                try { return [entry, fs.realpathSync(entry)]; }
                catch (error) { if (error.code === 'ENOENT') return [entry, null]; throw error; }
            })));
            for (const entry of packages) state.set(path.join(entry, 'package.json'), read(path.join(entry, 'package.json')));
        }
        const visited = new Set();
        for (const file of filenames) {
            let directory = path.dirname(file);
            while (!visited.has(directory)) {
                visited.add(directory);
                const manifest = path.join(directory, 'package.json');
                const content = read(manifest);
                if (content !== null) { state.set(manifest, content); break; }
                const parent = path.dirname(directory);
                if (parent === directory) break;
                directory = parent;
            }
        }
        const compilers = new Set();
        for (const directory of new Set([this.cwd, ...filenames.filter(file => file.endsWith('.imba')).map(file => path.dirname(file))])) {
            try { compilers.add(createRequire(path.join(directory, 'package.json')).resolve('imba/compiler')); }
            catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
        }
        for (const compiler of compilers) state.set(compiler, read(compiler));
        return state;
    }

    sync(selected) {
        const next = this.capture(selected);
        const changes = [...next.sources].flatMap(([file, content]) => {
            const previous = this.sources.get(file);
            return previous !== undefined && previous !== content ? [{ file, previous, content }] : [];
        });
        const removed = [...this.sources.keys()].filter(file => !next.sources.has(file));
        const reasons = [];
        if (this.configuration !== null) {
            if (!equal(this.configuration, next.configuration)) reasons.push('configuration');
            if (!equal(this.dependencies, next.dependencies)) reasons.push('dependencies');
            if (!equal(this.members, next.members) || removed.length) reasons.push('file structure');
            if (changes.some(change => change.file.split(path.sep).includes('node_modules'))) reasons.push('dependency sources');
        }
        Object.assign(this, next);
        return { changes, reset: reasons.length > 0, reasons };
    }

    remember(files) {
        // projectInfo adds imported sources and declarations outside config includes.
        for (const file of files) {
            if (!/\.(?:imba|[cm]?[jt]sx?|json)$/.test(file) || this.sources.has(file)) continue;
            const content = read(file);
            if (content !== null) { this.known.add(file); this.sources.set(file, content); }
        }
        if (this.dependencies) {
            for (const [file, value] of this.dependencyState(this.sources.keys())) {
                if (!this.dependencies.has(file)) this.dependencies.set(file, value);
            }
        }
    }
}
