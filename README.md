This tool helps to work with [Imba](https://imba.io) projects under [Bun](https://bun.sh). That is why it is called Bun+IMBA = BIMBA 😉

It includes the plugin for Bun to compile .imba files and also the CLI tool for buiding .imba files, since the plugins can't be passed to Bun via shell command `bun build`.

First of all install this tool like any other npm package:
```bash
bun add bimba-cli
```

Then create a `bunfig.toml` file in the root folder of your project, and add only one line in it (I could not find any workaround to do this automatically):
```bash
preload = ["bimba-cli/plugin.ts"]
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

###Frontend development
For frontend you will need to compile and bundle your source code from .imba to .js. And here the bimba-cli will help:
```bash
bunx bimba src/index.imba --outdir public
```
Or with the watch argument: 
```bash
bunx bimba src/index.imba --outdir public --watch
```

There are additional arguments that you can pass to the bimba:

`--sourcemap` - to tell Bun how to inculde sourcemap files in the final .js. It is `none` by default.

`--minify` - to minify the final JS code in the bundle produced by Bun. It is `false` by default.

`platform` - the value of this argument will be passed to the Imba compiler. By default it is `browswer`. The value `node` does not work under Bun.

####Live reload
Initially I implemented the live reload functionality, but then decided to refuse it. There is a pretty good VS Code extension: [Lite Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer).
It does everything needed out of the box. 

Just let bimba rebuild the sources on change and Lite Server will reload the page in the browser.