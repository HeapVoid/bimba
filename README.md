This tool helps to work with [Imba](https://imba.io) projects under [Bun](https://bun.sh). That is why it is called Bun+IMBA = BIMBA 😉

It includes the plugin for Bun to compile .imba files and also the CLI tool for buiding .imba files, since the plugins can't be passed to Bun via shell command `bun build`.

First of all install this tool like any other npm package:
```bash
bun add bimba-cli
```

Then create a `bunfig.toml` file in the root folder of your project, and add only one line in it (I could not find any workaround to do this automatically):
```bash
preload = ["bimba-cli/plugin.js"]
```

You are done!

### Backend development
Now to run an .imba file in Bun's environment you can use the usual Bun syntax: 
```bash
bun run src/index.imba
```
Or with the watch argument:
```bash
bun --watch run src/index.imba
```

### Frontend development
For frontend you will need to compile and bundle your source code from .imba to .js. And here the bimba-cli will help:
```bash
bunx bimba src/index.imba --outdir public
```
Or with the watch argument: 
```bash
bunx bimba src/index.imba --outdir public --watch
```

Here are all the available argumentsthat you can pass to the bimba:

`--watch` - Monitors changes in the directory where the entry point is located, and rebuilds the projects when the change occures. Keep entrypoint file in the subfolder, otherwise Bun will trigger several times since the cache dir update also triggers rebuilding.

`--clearcache` - If is set, the cache directory is deleted when bimba exits. Works only in the watch mode, since when bundling cache will be used next time to speed up the compiling time.

```bash
bunx bimba src/index.imba --outdir public --watch --clearcache
```

`--sourcemap` - Tells Bun how to inculde sourcemap files in the final .js. It is `none` by default.

```bash
bunx bimba src/index.imba --outdir public --sourcemap inline
```

`--minify` - If is set the final JS code in the bundle produced by Bun will be minified. It is `false` by default.

```bash
bunx bimba src/index.imba --outdir public --minify
```

`--platform` - The value of this argument will be passed to the Imba compiler. By default it is `browswer`. The value `node` does not work under Bun.

```bash
bunx bimba src/index.imba --outdir public --platform browser
```

#### Live reload
Initially I have implemented the live reload functionality, but then decided to refuse it. There is a pretty good VS Code extension: [Lite Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer).
It does everything needed out of the box. 

Just let bimba rebuild the sources on change and Lite Server will reload the page in the browser.