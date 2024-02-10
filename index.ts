#!/usr/bin/env bun

import { parseArgs } from "util";
import ansis from 'ansis';
import { imbaPlugin, stats } from './plugin.ts'
import fs from 'fs'
import path from 'path';

let flags = {};
let folders = {};

try {
    const { values, positionals } = parseArgs({
        args: Bun.argv,
        options: {
            watch: { type: 'boolean' },
            outdir: { type: 'string' },
            help: { type: 'boolean' },
            minify: { type: 'boolean' },
            target: { type: 'string' },
            sourcemap: { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
    });
    flags = values;
    flags.entry = Bun.argv[2];
    folders = positionals;
}
catch (error) {
    if (error instanceof Error)
        console.log(error.message);
    else
        console.log("Could not resolve CLI arguments. Read help to know them: " + theme.flags('--entry file.imba'));
    process.exit(1);
}

const theme = {
    flags: ansis.fg(5),
    count: ansis.fg(15).bold,
	start: ansis.fg(252).bg(233),
	filedir: ansis.fg(15),
	success: ansis.fg(40),
	failure: ansis.fg(196),
	time: ansis.fg(41),
	link: ansis.fg(15),
	online: ansis.fg(40).bg(22)
};

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
    console.log("");
    process.exit(1);
}


// no entrypoint or outdir
if(!flags.entry || !flags.outdir) {
    console.log("");
    console.log("You should provide entrypoint and the output dir: "+theme.flags('bimba file.imba --outdir public'));
    console.log("For more information: "+theme.flags('--help'));
    console.log("");
    process.exit(1);
}

// build
bundle();
watch(bundle);

function watch(callback) {
    if (flags.watch) {
        const watcher = fs.watch(path.dirname(flags.entry), {recursive: true}, async (event, filename) => ( callback() ));
    
        process.on("SIGINT", () => {
            if(watcher) {
                watcher.close();
                process.exit(0);
            }
        });
    }
}

async function bundle() {
    if (!fs.existsSync(flags.entry)) {
        console.log(theme.failure('Error.') + ` The specified entrypoint does not exist: ${theme.filedir(flags.entry)}`);
        process.exit(1);
    }

    //if (!fs.existsSync(flags.bundle)){ fs.mkdirSync(flags.bundle);}

    stats.failed = 0
    stats.compiled = 0
    stats.errors = 0
    stats.bundled = 0

    const start = Date.now();

    console.log("──────────────────────────────────────────────────────────────────────");
    console.log(theme.start(`Start building the Imba entrypoint: ${theme.filedir(flags.entry)}`));

    const result = await Bun.build({
        entrypoints: [flags.entry],
        outdir: flags.outdir,
        target: flags.target || 'browser',
        sourcemap: flags.sourcemap || 'none',
        minify: flags.minify || true,
        plugins: [imbaPlugin]
    });

    if(stats.failed)
        console.log(theme.start(theme.failure("Failure.") +` Imba compiler failed to proceed ${theme.count(stats.failed)} file${stats.failed > 1 ? 's' : ''}`));
    else
        console.log(theme.start(theme.success("Success.") +` It took ${theme.time(Date.now() - start)} ms to bundle ${theme.count(stats.bundled)} file${stats.bundled > 1 ? 's' : ''} to the folder: ${theme.filedir(flags.outdir)}`));

    if(!result.success && !stats.errors){
        for (const log of result.logs) {
            console.log(log);
        }
    }
}