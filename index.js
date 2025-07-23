#!/usr/bin/env bun

import { parseArgs } from "util";
import { imbaPlugin, stats, cache } from './plugin.js'
import {theme} from './utils.js';
import fs from 'fs'
import path from 'path';
import { rmSync } from "node:fs";


let flags = {}
let entrypoint = ''

try {
    const { values, positionals } = parseArgs({
        args: Bun.argv,
        options: {
            watch: { type: 'boolean' },
            outdir: { type: 'string' },
            help: { type: 'boolean' },
            clearcache: { type: 'boolean' },
            minify: { type: 'boolean' },
            target: { type: 'string' },
            sourcemap: { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
    });
    flags = values;
    entrypoint = Bun.argv[2];
}
catch (error) {
    if (error instanceof Error)
        console.log(error.message);
    else
        console.log("Could not resolve CLI arguments. Read help to know them: " + theme.flags('--entry file.imba'));
    process.exit(0);
}

// help: more on bun building params here: https://bun.sh/docs/bundler
if(flags.help) {
    console.log("");
    console.log("Bimba requeres an .imba file and a folder where to put compiled .js files.");
    console.log("For example like this: "+theme.filedir('bimba file.imba --outdir public'));
    console.log("");
    console.log("   "+theme.flags('--outdir <folder>')+"                     Compile imba files to the specified folder");
    console.log("   "+theme.flags('--minify')+"                              Minify compiled .js files");
    console.log("   "+theme.flags('--sourcemap <inline|external|none>')+"    How should sourcemap files be included in the .js");
    console.log("   "+theme.flags('--platform <browser|node>')+"             Flag that will be passed to Imba compiler ('node' value does not work in Bun)");
    console.log("   "+theme.flags('--watch')+"                               Watch for changes in the entrypoint folder");
    console.log("   "+theme.flags('--clearcache')+"                          Clear cache on exit, works only when in watch mode");
    console.log("");
    process.exit(0);
}


// no entrypoint or outdir
if(!entrypoint || !flags.outdir) {
    console.log("");
    console.log("You should provide entrypoint and the output dir: "+theme.flags('bimba file.imba --outdir public'));
    console.log("For more information: "+theme.flags('--help'));
    console.log("");
    process.exit(1);
}

// build
let bundling = false;
bundle();
watch(bundle);

function watch(callback) {
    if (flags.watch) {
        const watcher = fs.watch(path.dirname(entrypoint), {recursive: true}, async (event, filename) => ( callback() ));
    
        process.on("SIGINT", () => {
            if(flags.clearcache) rmSync(cache, { recursive: true, force: true });

            if(watcher) {
                watcher.close();
                process.exit(0);
            }
        });
    }
}

async function bundle() {
    if (bundling) return;
    bundling = true;

    if (!fs.existsSync(entrypoint)) {
        console.log(theme.failure('Error.') + ` The specified entrypoint does not exist: ${theme.filedir(entrypoint)}`);
        process.exit(0);
    }

    stats.failed = 0
    stats.compiled = 0
    stats.errors = 0
    stats.bundled = 0

    const start = Date.now();

    console.log(theme.folder("──────────────────────────────────────────────────────────────────────"));
    console.log(theme.start(`Start building the Imba entrypoint: ${theme.filedir(entrypoint)}`));
    
    let result = undefined
    try {
        result = await Bun.build({
            entrypoints: [entrypoint],
            outdir: flags.outdir,
            target: flags.target || 'browser',
            sourcemap: flags.sourcemap || 'none',
            minify: flags.minify || true,
            plugins: [imbaPlugin]
        });

        if(stats.failed)
            console.log(theme.start(theme.failure(" Failure ") + theme.filename(` Imba compiler failed to proceed ${stats.failed} file${stats.failed > 1 ? 's' : ''}`)));
        else
            console.log(theme.start(theme.success("Success") +` It took ${theme.time(Date.now() - start)} ms to bundle ${theme.count(stats.bundled)} file${stats.bundled > 1 ? 's' : ''} to the folder: ${theme.filedir(flags.outdir)}`));

        if(!result.success && !stats.errors){
            for (const log of result.logs) {
                console.log(log);
            }
        }
    }
    catch(error) {
        console.log(theme.folder("──────────────────────────────────────────────────────────────────────"));
        console.log('')
        console.log(error)
        console.log(theme.folder("──────────────────────────────────────────────────────────────────────"));
        console.log(theme.failure(" Failure ") + theme.filename(' Bun found an error in the compiled JS file'))
    }
    finally {
        bundling = false;
    };
}