import { RuntimeResolver } from '../../src/jvm/runtimeResolver.js';

/** A RuntimeResolver that resolves immediately to the given paths, without probing Java or the jar. */
export function fixedRuntime(javaPath: string, jarPath: string, javaVersion = 17): RuntimeResolver {
  return new RuntimeResolver({
    findJava: () => ({ javaPath, version: javaVersion }),
    resolveJar: async () => ({ jarPath, downloaded: false, source: 'env' }),
  });
}
