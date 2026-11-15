const { loadPlugin } = require('../plugin-compiler.cjs');
const { VirtualTypeScriptCache } = require('./cache.cjs');
const installed = new WeakSet();
const caches = new Map();

module.exports = modules => {
    const plugin = loadPlugin(process.env.BIMBA_TYPECHECK_PLUGIN);
    if (!caches.has(plugin.identity)) caches.set(plugin.identity, new VirtualTypeScriptCache(process.cwd(), process.env.BIMBA_TYPECHECK_PLUGIN));
    const cache = caches.get(plugin.identity);
    const prototype = plugin.Compilation?.prototype;
    if (prototype && !installed.has(prototype)) {
        installed.add(prototype);
        cache.stats.enabled = true;
        const resolve = prototype.getCompiler;
        const compilers = new WeakMap();
        prototype.getCompiler = function() {
            const compiler = resolve.call(this);
            if (!compilers.has(compiler)) {
                compilers.set(compiler, new Proxy(compiler, { get(target, property) {
                    return property === 'compile' ? (source, options) => cache.compile(target, source, options) : Reflect.get(target, property);
                } }));
            }
            return compilers.get(compiler);
        };
    }
    const service = plugin.factory(modules);
    return {
        create(info) {
            const languageService = service.create(info);
            if (!process.env.BIMBA_PROFILE_TYPECHECK) return languageService;
            let lastProfile;
            // Read-only profiling after mapped diagnostics. No compiler results,
            // TypeScript diagnostics or project configuration are replaced.
            return new Proxy(languageService, { get(target, property) {
                if (property !== 'getSemanticDiagnostics') return Reflect.get(target, property);
                return (...args) => {
                    const diagnostics = target.getSemanticDiagnostics(...args);
                    const profile = cache.report();
                    const key = JSON.stringify(profile);
                    if (key !== lastProfile) { lastProfile = key; info.session?.event(profile, 'bimbaCacheProfile'); }
                    return diagnostics;
                };
            } });
        },
        getExternalFiles(project) { return service.getExternalFiles?.(project) ?? []; },
        onConfigurationChanged(configuration) { service.onConfigurationChanged?.(configuration); },
    };
};
