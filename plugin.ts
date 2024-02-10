import { plugin, type BunPlugin } from "bun";
import ansis from 'ansis';
import * as compiler from 'imba/compiler'
import dir from 'path'
import fs from 'fs'

// theme for messages printed in terminal
// color pallete can be seen here: https://raw.githubusercontent.com/webdiscus/ansis/master/docs/img/ansi256.png
// for more details read the project page: https://github.com/webdiscus/ansis
const theme = {
  action: ansis.fg(237),
  folder: ansis.fg(240),
  filename: ansis.fg(15),
  success: ansis.fg(40),
  failure: ansis.fg(15).bg(124),
};

const cache = process.cwd() + '/.cache/';
if (!fs.existsSync(cache)){ fs.mkdirSync(cache);}

// this should be reset from outside to get results of entrypoint building
export let stats = {
  failed: 0,
  compiled: 0,
  cached: 0,
  bundled: 0,
  errors: 0
};

export const imbaPlugin: BunPlugin = {
  name: "imba",
  async setup(build) {

      // when there is import without file extension
      build.onResolve({filter: /^.*[^.]{5}$/ }, ({ path, importer }) => {
      
      let filename = path;
      // resolve relative path
      if (path.startsWith('.')) { filename = dir.resolve(dir.dirname(importer), filename) };

      // assume that the file is .js
      try { return {path: Bun.resolveSync(filename + '.js', '.')}}
      catch (error) {
        // assume that the file is .mjs
        try { return {path: Bun.resolveSync(filename + '.mjs', '.')}}
        catch (error) {
          // assume that the file is .cs
          try { return {path: Bun.resolveSync(filename + '.cjs', '.')}}
          catch (error) {
            // assume that the file is .imba
            try { return {path: Bun.resolveSync(filename + '.imba', '.')}}
            catch (error) {
              // if direct resolution failed
              filename += '.imba';
              
              // assume that the relative path should be resolved relative to importer
              let fn = dir.resolve(dir.dirname(importer), filename);
              if (fs.existsSync(fn)) return {path: fn};
              // assume that the relative path should be resolved relative to node_modules
              fn = dir.resolve('./node_modules', filename);
              if (fs.existsSync(fn)) return {path: fn};
              // assume that the relative path should be resolved relative to project root
              fn = dir.resolve(process.cwd(), filename);
              if (fs.existsSync(fn)) return {path: fn};
              
              // if the path still is unresolved throw error and leave the further resolution on Bun's resolver
              if (error instanceof Error) {
                throw new Error(error.message);
              }
              else
                throw new Error('Could not resolve file: ' + path);
            }
          }
        }
      }
    })

    // when an .imba file is imported...
    build.onLoad({ filter: /\.imba$/ }, async ({ path }) => {
      
      const f = dir.parse(path)
      let contents = '';
      
      // return the cached version if it exists
      const cached = cache + Bun.hash(path + fs.statSync(path).mtimeMs) + '_' + f.name + '.js';;
      if (fs.existsSync(cached)) {
        stats.bundled++;
        stats.cached++;
        //console.log(theme.action("cached: ") + theme.folder(f.dir + '/') + theme.filename(f.base) + " - " + theme.success("ok"));
        return {
          contents: await Bun.file(cached).text(),
          loader: "js",
        };
      }

      // if no cached version read and compile it with the imba compiler
      const file = await Bun.file(path).text();
      const out = compiler.compile(file, {
        sourcePath: path,
        platform: 'browser'
      })
      
      // print about file complitaion
      console.write(theme.action("compiling: ") + theme.folder(f.dir + '/') + theme.filename(f.base) + " - ");

      // the file has been successfully compiled
      if (!out.errors || !out.errors.length) {
        stats.bundled++;
        stats.compiled++;
        contents = out.js;
        await Bun.write(cached, contents);
        console.write(theme.success("cached" + "\n"));
      }
      // there were errors during compilation
      else {
        console.write(theme.failure(" fail ") + "\n");
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

type imbaCompilerError = {
  toSnippet: Function;
  toError: Function;
  message: string;
  range: {
    start: {
      line: number
    }
  }
}

// print an error generated by the imba compiler
function printerr(err: imbaCompilerError) {
  
  // halper function to produce empty strings
  const fill = (len = 0) => {return new Array(len + 1).join(' ')}
  
  // set color theme for an error message
  const colors = {
    code: ansis.fg(252).bg(238),
    margin: ansis.fg(229).bg(145),
    error: ansis.fg(196).bg(52),
    ecode: ansis.fg(196).bg(238).bold,
  };

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
    colors.margin(fill(Math.min(start, display.margin.length))) + 
    colors.code(fill(Math.max(0, start - display.margin.length))) + 
    colors.error(display.error) +
    colors.margin(fill(Math.max(0, display.margin.length - end))) +
    colors.code(fill(Math.min(total - display.margin.length, total - end)))
  );

  // print line with the source code
  console.log(
    display.outdent + 
    colors.margin(display.margin) + 
    colors.code(display.source.slice(0,display.errs)) + 
    colors.error(display.source.slice(display.errs,display.erre)) + 
    colors.code(display.source.slice(display.erre)) +
    colors.code(fill(total - display.source.length - display.margin.length))
  );

  // print empty line to balance the view 
  // later we can put something usefull here
  // for example a link to online docs about the error
  console.log(
    display.outdent + 
    colors.margin(fill(display.margin.length)) + 
    colors.code(fill(total - display.margin.length))
  );

  // print emtpy line
  console.log('');
}
