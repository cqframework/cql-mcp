import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectJavaCandidates,
  findJavaRuntime,
  parseJavaMajorVersion,
  resolveJavaBinary,
  whichInPath,
} from '../../../src/jvm/javaLocator.js';
import { onPosix, onWindows } from '../../helpers/platform.js';

describe('jvm/javaLocator', () => {
  describe('parseJavaMajorVersion', () => {
    const cases: Array<[string, number | null]> = [
      ['openjdk version "17.0.17" 2025-10-21', 17],
      ['java version "1.8.0_202"', 8],
      ['java version "11.0.2" 2019-01-15 LTS', 11],
      ['openjdk version "21" 2023-09-19', 21],
      ['not a version string', null],
    ];
    for (const [input, expected] of cases) {
      it(`parses ${JSON.stringify(input.split(' ').slice(0, 2).join(' '))} -> ${expected}`, () => {
        expect(parseJavaMajorVersion(input)).to.equal(expected);
      });
    }
  });

  describe('collectJavaCandidates', () => {
    it('prefers JAVA_HOME before PATH', () => {
      const candidates = collectJavaCandidates('/opt/jdk17');
      expect(candidates[0]).to.equal(path.join('/opt/jdk17', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
      expect(candidates).to.include(process.platform === 'win32' ? 'java.exe' : 'java');
    });
  });

  describe('whichInPath', () => {
    it('finds an executable on PATH', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-java-'));
      try {
        const binPath = path.join(dir, process.platform === 'win32' ? 'java.exe' : 'java');
        fs.writeFileSync(binPath, '');
        const found = whichInPath(process.platform === 'win32' ? 'java.exe' : 'java', dir);
        expect(path.resolve(found!)).to.equal(path.resolve(binPath));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    it('returns null when nothing is on PATH', () => {
      expect(whichInPath('java', '')).to.equal(null);
    });
  });

  describe('resolveJavaBinary', () => {
    it('resolves an absolute path form', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-java-'));
      try {
        const binPath = path.join(dir, 'java');
        fs.writeFileSync(binPath, '');
        expect(resolveJavaBinary(binPath)).to.equal(path.resolve(binPath));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    it('returns null for a missing path form', () => {
      expect(resolveJavaBinary('/definitely/not/here/java')).to.equal(null);
    });

    // A bare name is searched on PATH; anything with a directory part is used as a path.
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    function withDir(fn: (dir: string, emptyDir: string) => void): void {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-java-'));
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-java-empty-'));
      try {
        fn(dir, emptyDir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    }
    it('a bare name takes the PATH-search branch', () => {
      withDir((dir, emptyDir) => {
        fs.writeFileSync(path.join(dir, exe), '');
        expect(resolveJavaBinary(exe, dir)).to.equal(path.join(dir, exe));
        expect(resolveJavaBinary(exe, emptyDir)).to.equal(null);
      });
    });
    it('path.join(dir, exe) takes the path branch, ignoring PATH', () => {
      withDir((dir, emptyDir) => {
        const bin = path.join(dir, exe);
        fs.writeFileSync(bin, '');
        expect(resolveJavaBinary(bin, emptyDir)).to.equal(path.resolve(bin));
      });
    });
    onPosix('native forms', () => {
      it("'jdk\\bin\\java' is a bare command name (a backslash is a filename character)", () => {
        withDir((dir, emptyDir) => {
          const name = 'jdk\\bin\\java';
          fs.writeFileSync(path.join(dir, name), '');
          expect(resolveJavaBinary(name, dir)).to.equal(path.join(dir, name));
          expect(resolveJavaBinary(name, emptyDir)).to.equal(null);
          expect(resolveJavaBinary('nonexistent\\java', emptyDir)).to.equal(null);
        });
      });
    });
    onWindows('native forms', () => {
      for (const sep of ['\\', '/']) {
        it(`a ${sep === '/' ? 'forward-slash' : 'backslash'} path (C:${sep}jdk${sep}bin${sep}java.exe form) is a path form`, () => {
          withDir((dir, emptyDir) => {
            const bin = path.join(dir, 'java.exe');
            fs.writeFileSync(bin, '');
            const given = bin.replace(/[\\/]/g, sep);
            expect(resolveJavaBinary(given, emptyDir)).to.equal(path.resolve(bin));
          });
        });
      }
      it("'C:\\jdk\\bin\\java.exe' and 'C:/jdk/bin/java.exe' are path forms (missing -> null)", () => {
        expect(resolveJavaBinary('C:\\jdk\\bin\\java.exe')).to.equal(null);
        expect(resolveJavaBinary('C:/jdk/bin/java.exe')).to.equal(null);
      });
    });
  });

  describe('findJavaRuntime', () => {
    // Only exercised when a real JDK >= 17 exists on this machine.
    it('detects the real JDK when present (integration-gated)', function () {
      if (process.env.CQL_MCP_SKIP_JAVA) {
        this.skip();
      }
      const runtime = findJavaRuntime(process.env.JAVA_HOME);
      if (!runtime) {
        this.skip();
        return;
      }
      expect(runtime.version).to.be.greaterThanOrEqual(17);
      expect(fs.existsSync(runtime.javaPath)).to.equal(true);
    });
  });
});