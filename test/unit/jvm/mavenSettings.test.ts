import { expect } from 'chai';
import { onPosix, onWindows } from '../../helpers/platform.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findCentralMirror,
  loadMavenSettings,
  mavenSettingsPaths,
  mirrorMatchesCentral,
} from '../../../src/jvm/mavenSettings.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cql-settings-'));
}

function write(file: string, xml: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, xml);
}

describe('jvm/mavenSettings', () => {
  const dirs: string[] = [];
  const home = (): string => {
    const d = tempDir();
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  describe('mirrorMatchesCentral', () => {
    const cases: Array<[string, boolean]> = [
      ['central', true],
      ['*', true],
      ['external:*', true],
      ['  central  ', true],
      ['repo1, central', true],
      ['repo1 , *', true],
      ['*,!central', false],
      ['!central,*', false],
      ['external:*, !central', false],
      [' * , ! central'.replace('! ', '!'), false],
      ['repo1', false],
      ['', false],
      ['!repo1,*', true],
    ];
    for (const [mirrorOf, expected] of cases) {
      it(`'${mirrorOf}' -> ${expected}`, () => {
        expect(mirrorMatchesCentral(mirrorOf)).to.equal(expected);
      });
    }
  });

  describe('loading', () => {
    it('gives empty settings for a missing file', () => {
      const s = loadMavenSettings({ homeDir: home(), env: {} });
      expect(s).to.deep.equal({ mirrors: [], servers: [], warnings: [] });
    });

    it('reads mirrors and servers from ~/.m2/settings.xml', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        `<settings><mirrors><mirror><id>corp</id><url>https://m.test/central</url><mirrorOf>*</mirrorOf></mirror></mirrors>
         <servers><server><id>corp</id><username>alice</username><password>1234</password></server></servers></settings>`,
      );
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s.mirrors).to.deep.equal([{ id: 'corp', url: 'https://m.test/central', mirrorOf: '*' }]);
      expect(s.servers).to.deep.equal([{ id: 'corp', username: 'alice', password: '1234' }]); // password stays a string
      expect(s.warnings).to.deep.equal([]);
    });

    it('ignores <localRepository> and <proxies>', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        `<settings><localRepository>/somewhere/repo</localRepository>
         <proxies><proxy><id>p</id><host>proxy.test</host><port>3128</port></proxy></proxies></settings>`,
      );
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s).to.deep.equal({ mirrors: [], servers: [], warnings: [] });
      expect(JSON.stringify(s)).to.not.include('somewhere').and.to.not.include('proxy.test');
    });

    it('user settings override global settings by id, and user mirrors come first', () => {
      const h = home();
      const mavenHome = home();
      write(
        path.join(mavenHome, 'conf', 'settings.xml'),
        `<settings><mirrors>
           <mirror><id>shared</id><url>https://global.test/shared</url><mirrorOf>central</mirrorOf></mirror>
           <mirror><id>only-global</id><url>https://global.test/other</url><mirrorOf>external:*</mirrorOf></mirror>
         </mirrors>
         <servers>
           <server><id>shared</id><username>global-user</username><password>g</password></server>
           <server><id>only-global</id><username>gu</username><password>gp</password></server>
         </servers></settings>`,
      );
      write(
        path.join(h, '.m2', 'settings.xml'),
        `<settings><mirrors><mirror><id>shared</id><url>https://user.test/shared</url><mirrorOf>*</mirrorOf></mirror></mirrors>
         <servers><server><id>shared</id><username>user-user</username><password>u</password></server></servers></settings>`,
      );
      const s = loadMavenSettings({ homeDir: h, env: { MAVEN_HOME: mavenHome } });
      expect(s.mirrors.map((m) => `${m.id}=${m.url}`)).to.deep.equal([
        'shared=https://user.test/shared',
        'only-global=https://global.test/other',
      ]);
      expect(s.servers.find((x) => x.id === 'shared')).to.deep.equal({ id: 'shared', username: 'user-user', password: 'u' });
      expect(s.servers.find((x) => x.id === 'only-global')?.username).to.equal('gu');
    });

    it('falls back to M2_HOME for the global settings', () => {
      const mavenHome = home();
      write(
        path.join(mavenHome, 'conf', 'settings.xml'),
        '<settings><mirrors><mirror><id>m</id><url>https://x.test/</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>',
      );
      const s = loadMavenSettings({ homeDir: home(), env: { M2_HOME: mavenHome } });
      expect(s.mirrors).to.have.length(1);
    });

    it('CQL_LS_MAVEN_SETTINGS replaces ~/.m2/settings.xml', () => {
      const h = home();
      write(path.join(h, '.m2', 'settings.xml'), '<settings><mirrors><mirror><id>home</id><url>https://home.test/</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>');
      const custom = path.join(home(), 'my-settings.xml');
      write(custom, '<settings><mirrors><mirror><id>custom</id><url>https://custom.test/</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>');
      const s = loadMavenSettings({ homeDir: h, env: { CQL_LS_MAVEN_SETTINGS: custom } });
      expect(s.mirrors.map((m) => m.id)).to.deep.equal(['custom']);
    });

    it('findCentralMirror picks the first mirror that matches central, as Maven does', () => {
      const s = {
        warnings: [],
        servers: [],
        mirrors: [
          { id: 'a', url: 'https://a.test/', mirrorOf: 'other' },
          { id: 'b', url: 'https://b.test/', mirrorOf: '*,!central' },
          { id: 'c', url: 'https://c.test/', mirrorOf: 'external:*' },
          { id: 'd', url: 'https://d.test/', mirrorOf: '*' },
        ],
      };
      expect(findCentralMirror(s)?.id).to.equal('c');
    });
  });

  describe('placeholders', () => {
    it('fills in ${user.home} and ${env.NAME} in mirror URLs and server credentials', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        `<settings><mirrors><mirror><id>m</id><url>https://\${env.REPO_HOST}/central</url><mirrorOf>*</mirrorOf></mirror></mirrors>
         <servers><server><id>m</id><username>\${env.REPO_USER}</username><password>\${env.REPO_PW}</password></server></servers></settings>`,
      );
      const s = loadMavenSettings({ homeDir: h, env: { REPO_HOST: 'repo.corp.test', REPO_USER: 'alice', REPO_PW: 's3' } });
      expect(s.mirrors[0].url).to.equal('https://repo.corp.test/central');
      expect(s.servers[0]).to.deep.equal({ id: 'm', username: 'alice', password: 's3' });
      expect(s.warnings).to.deep.equal([]);
    });

    it('expands ${user.home} to the given home directory', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        '<settings><mirrors><mirror><id>m</id><url>file://${user.home}/repo</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>',
      );
      expect(loadMavenSettings({ homeDir: h, env: {} }).mirrors[0].url).to.equal(`file://${h}/repo`);
    });

    it('an unresolved ${env.X} skips that value with a warning (never the placeholder value)', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        `<settings><mirrors><mirror><id>m</id><url>https://x.test/</url><mirrorOf>*</mirrorOf></mirror></mirrors>
         <servers><server><id>m</id><username>alice</username><password>\${env.MISSING_PW}</password></server></servers></settings>`,
      );
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s.servers[0]).to.deep.equal({ id: 'm', username: 'alice' });
      expect(s.warnings).to.have.length(1);
      expect(s.warnings[0]).to.include("'m'").and.to.include('placeholder');
    });

    it('an unresolved placeholder in a mirror <url> skips the mirror with a warning', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        '<settings><mirrors><mirror><id>m</id><url>https://${env.NOPE}/</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>',
      );
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s.mirrors).to.deep.equal([]);
      expect(s.warnings[0]).to.include("'m'");
    });
  });

  describe('encrypted passwords and bad files', () => {
    it('skips an encrypted {…} password with a warning, keeping the server entry', () => {
      const h = home();
      write(
        path.join(h, '.m2', 'settings.xml'),
        '<settings><servers><server><id>m</id><username>alice</username><password>{COQLCtL4hzIHnnu+b6JB5FKPw/bvmE4yw3vFfZ0k7yI=}</password></server></servers></settings>',
      );
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s.servers[0]).to.deep.equal({ id: 'm', username: 'alice' });
      expect(s.warnings[0]).to.include('settings-security.xml');
      expect(s.warnings.join('\n')).to.not.include('COQLCtL4');
    });

    it('malformed XML gives empty settings plus a warning, and never throws', () => {
      const h = home();
      write(path.join(h, '.m2', 'settings.xml'), '<settings><mirrors><mirror>');
      const s = loadMavenSettings({ homeDir: h, env: {} });
      expect(s.mirrors).to.deep.equal([]);
      expect(s.warnings.join('\n')).to.match(/malformed|no <settings>/);
    });

    it('a file without a <settings> root gives a warning', () => {
      const h = home();
      write(path.join(h, '.m2', 'settings.xml'), '<other/>');
      expect(loadMavenSettings({ homeDir: h, env: {} }).warnings).to.have.length(1);
    });

    it('an empty <mirrors/> element is fine', () => {
      const h = home();
      write(path.join(h, '.m2', 'settings.xml'), '<settings><mirrors/><servers/></settings>');
      expect(loadMavenSettings({ homeDir: h, env: {} })).to.deep.equal({ mirrors: [], servers: [], warnings: [] });
    });
  });

  describe('settings file locations', () => {
    // Each host tests its own native forms (ADR-0003):
    //   host            input                                user settings
    //   macOS / Linux   home /home/u                         /home/u/.m2/settings.xml
    //   Windows         home C:\Users\u or C:/Users/u        C:\Users\u\.m2\settings.xml
    //   any             CQL_LS_MAVEN_SETTINGS=<file>         used as-is
    //   macOS / Linux   MAVEN_HOME=/opt/mvn (and /opt/mvn/)  /opt/mvn/conf/settings.xml
    //   Windows         MAVEN_HOME=C:\mvn (and C:\mvn\)      C:\mvn\conf\settings.xml
    it('joins under a home built with path.join', () => {
      const home = path.join(os.tmpdir(), 'home-u');
      expect(mavenSettingsPaths({ homeDir: home, env: {} }).user).to.equal(path.join(home, '.m2', 'settings.xml'));
    });
    it('CQL_LS_MAVEN_SETTINGS is used as-is', () => {
      const file = path.join(os.tmpdir(), 'tools', 'settings.xml');
      expect(mavenSettingsPaths({ homeDir: '/h', env: { CQL_LS_MAVEN_SETTINGS: file } }).user).to.equal(file);
    });
    it('MAVEN_HOME builds the global settings path', () => {
      const mvn = path.join(os.tmpdir(), 'mvn');
      expect(mavenSettingsPaths({ homeDir: '/h', env: { MAVEN_HOME: mvn } }).global).to.equal(
        path.join(mvn, 'conf', 'settings.xml'),
      );
      expect(mavenSettingsPaths({ homeDir: '/h', env: { M2_HOME: mvn } }).global).to.equal(
        path.join(mvn, 'conf', 'settings.xml'),
      );
    });
    onPosix('native forms', () => {
      it('/home/u', () => {
        expect(mavenSettingsPaths({ homeDir: '/home/u', env: {} }).user).to.equal('/home/u/.m2/settings.xml');
      });
      it('MAVEN_HOME with and without a trailing separator', () => {
        expect(mavenSettingsPaths({ homeDir: '/h', env: { MAVEN_HOME: '/opt/mvn' } }).global).to.equal('/opt/mvn/conf/settings.xml');
        expect(mavenSettingsPaths({ homeDir: '/h', env: { MAVEN_HOME: '/opt/mvn/' } }).global).to.equal('/opt/mvn/conf/settings.xml');
      });
    });
    onWindows('native forms', () => {
      it('C:\\Users\\u', () => {
        expect(mavenSettingsPaths({ homeDir: 'C:\\Users\\u', env: {} }).user).to.equal('C:\\Users\\u\\.m2\\settings.xml');
      });
      it('C:/Users/u (forward slashes)', () => {
        expect(mavenSettingsPaths({ homeDir: 'C:/Users/u', env: {} }).user).to.equal('C:\\Users\\u\\.m2\\settings.xml');
      });
      it('MAVEN_HOME with and without a trailing separator', () => {
        expect(mavenSettingsPaths({ homeDir: 'C:\\h', env: { MAVEN_HOME: 'C:\\mvn' } }).global).to.equal('C:\\mvn\\conf\\settings.xml');
        expect(mavenSettingsPaths({ homeDir: 'C:\\h', env: { MAVEN_HOME: 'C:\\mvn\\' } }).global).to.equal('C:\\mvn\\conf\\settings.xml');
      });
    });
  });
});
