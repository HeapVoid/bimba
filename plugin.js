import { plugin } from "bun";
import {theme} from './utils.js';
import * as compiler from 'imba/compiler'
import dir from 'path'
import fs from 'fs'
import { Glob } from "bun";
import { unlink } from "node:fs/promises";

export const cache = process.cwd() + '/.cache/';
if (!fs.existsSync(cache)){ fs.mkdirSync(cache);}

// this should be reset from outside to get results of entrypoint building
export let stats = {
  failed: 0,
  compiled: 0,
  cached: 0,
  bundled: 0,
  errors: 0,
};

export const imbaPlugin = {
  name: "imba",
  async setup(build) {

    // when an .imba file is imported...
    build.onLoad({ filter: /\.imba$/ }, async ({ path }) => {

      const f = dir.parse(path)
      let contents = '';

      // return the cached version if exists
      const cached = cache + Bun.hash(path) + '_' + fs.statSync(path).mtimeMs + '.js';
      if (fs.existsSync(cached)) {
        stats.bundled++;
        stats.cached++;
        //console.log(theme.action("cached: ") + theme.folder(f.dir + '/') + theme.filename(f.base) + " - " + theme.success("ok"));
        //console.log(theme.action("compiling: ") + theme.folder(dir.join(f.dir,'/')) + theme.filename(f.base) + " - " + theme.success("from cache"));
        return {
          contents: await Bun.file(cached).text(),
          loader: "js",
        };
      }

      // clear previous cached version
      const glob = new Glob(Bun.hash(path) + '_' + "*.js");
      for await (const file of glob.scan(cache)) if (fs.existsSync(cache + file)) unlink(cache + file);

      // if no cached version read and compile it with the imba compiler
      const file = await Bun.file(path).text();
      const out = compiler.compile(file, {
          sourcePath: path,
          platform: 'browser'
      })
      
      // the file has been successfully compiled
      if (!out.errors?.length) {
        console.log(theme.action("compiling: ") + theme.folder(dir.join(f.dir,'/')) + theme.filename(f.base) + " - " + theme.success("cached"));
        stats.bundled++;
        stats.compiled++;
        contents = out.js;
        await Bun.write(cached, contents);
      }
      // there were errors during compilation
      else {
        console.log(theme.action("compiling: ") + theme.folder(dir.join(f.dir,'/')) + theme.filename(f.base) + " - " + theme.failure(" fail "));
        stats.failed++;
        for (let i = 0; i < out.errors.length; i++) {
          if(out.errors[i]) printerr(out.errors[i]);
        }
        stats.errors++;
      }
      
      // and return the compiled source code as "js"
      return {
        contents,
        loader: "js",
      };
    });
  }
};

plugin(imbaPlugin);


// -------------------------------------------------------------------------------
// print pretty messages produced by the imba compiler 
// -------------------------------------------------------------------------------

// print an error generated by the imba compiler
function printerr(err) {
  
  // halper function to produce empty strings
  const fill = (len = 0) => {return new Array(len + 1).join(' ')}
  
   // gather the needed information from the compiler error
  const snippet = err.toSnippet().split("\n");
  const display = {
    error: " " + err.message + " ",
    outdent: fill(10),
    source: snippet[1] + "  ",
    margin: " line " + err.range.start.line + " ",
    errs: snippet[2].indexOf('^'),
    erre: snippet[2].lastIndexOf('^') + 1,
  };

  // calculate parameters for priniting a message
  const center = display.margin.length + display.errs + Math.floor((display.erre - display.errs) / 2);
  const half = Math.ceil((display.error.length - 1) / 2);
  const start = Math.max(0, center - half);
  const end = start + display.error.length;
  const total = Math.max(display.margin.length + display.source.length, end);

  // print emtpy line
  console.log('');

  // print line with the error message
  console.log(
    display.outdent +
    theme.margin(fill(Math.min(start, display.margin.length))) + 
    theme.code(fill(Math.max(0, start - display.margin.length))) + 
    theme.error(display.error) +
    theme.margin(fill(Math.max(0, display.margin.length - end))) +
    theme.code(fill(Math.min(total - display.margin.length, total - end)))
  );

  // print line with the source code
  console.log(
    display.outdent + 
    theme.margin(display.margin) + 
    theme.code(display.source.slice(0,display.errs)) + 
    theme.error(display.source.slice(display.errs,display.erre)) + 
    theme.code(display.source.slice(display.erre)) +
    theme.code(fill(total - display.source.length - display.margin.length))
  );

  // print empty line to balance the view 
  // later we can put something usefull here
  // for example a link to online docs about the error
  console.log(
    display.outdent + 
    theme.margin(fill(display.margin.length)) + 
    theme.code(fill(total - display.margin.length))
  );

  // print emtpy line
  console.log('');
}
