import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { projectCache, hash, atomicJSON, atomicWrite } from './compilation-store.cjs';

const pluginDirectory = fileURLToPath(new URL('./typecheck-plugin', import.meta.url));

export function resolveTypecheckPlugin(pluginProbe) {
    return fs.realpathSync(createRequire(path.join(pluginProbe, '__bimba__.js')).resolve('typescript-imba-plugin'));
}

export function startTypecheckWorker({ cwd, tsserver, pluginProbe, runner, stdio }) {
    const original = resolveTypecheckPlugin(pluginProbe);
    const probe = path.join(projectCache(cwd), 'plugin-host', hash(pluginDirectory + fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')).slice(0, 16));
    const host = path.join(probe, 'node_modules', 'typescript-imba-plugin');
    const loader = path.join(host, 'index.cjs');
    const contents = `module.exports = require(${JSON.stringify(path.join(pluginDirectory, 'index.cjs'))});\n`;
    // A real loader, rather than a directory symlink, also works when the TS
    // runtime uses --preserve-symlinks. No installed package is rewritten.
    const manifest = path.join(host, 'package.json');
    const metadata = { name: 'typescript-imba-plugin', private: true, main: 'index.cjs' };
    if (!fs.existsSync(loader) || fs.readFileSync(loader, 'utf8') !== contents
        || !fs.existsSync(manifest) || fs.readFileSync(manifest, 'utf8') !== JSON.stringify(metadata)) {
        atomicJSON(manifest, metadata);
        atomicWrite(loader, contents);
    }
    return spawn(runner, [tsserver, '--globalPlugins', 'typescript-imba-plugin',
        '--pluginProbeLocations', [probe, pluginProbe].join(',')], {
        cwd, stdio, env: { ...process.env, BIMBA_TYPECHECK_PLUGIN: original },
    });
}
