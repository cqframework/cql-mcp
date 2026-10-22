import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LanguageServerCrashedError, type CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';
import type { ExecuteCqlRequest, ExecuteCqlResponse } from '../../../src/lsp/protocol.js';
import { pathToUri } from '../../../src/workspace/paths.js';
import { runFile, runSuite } from '../../../src/testPipeline/suiteRunner.js';
import {
  listRuns,
  readLatestPointer,
} from '../../../src/testPipeline/resultStore.js';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'suiteRunner-'));
}

interface MockProcessState {
  calls: Array<{ command: string; args: unknown[] }>;
  queue: Array<ExecuteCqlResponse | Error>;
  ensureReadyCount: number;
}

function mkMockProcess(state: MockProcessState): CqlLsProcess {
  const process: Partial<CqlLsProcess> = {
    ensureReady: async () => {
      state.ensureReadyCount++;
    },
    executeCommand: async <T>(command: string, args: unknown[]): Promise<T> => {
      state.calls.push({ command, args });
      const next = state.queue.shift();
      if (!next) {
        throw new Error(`no queued response for call #${state.calls.length}`);
      }
      if (next instanceof Error) {
        throw next;
      }
      return next as T;
    },
    lspClient: {
      sendNotification: () => undefined,
    } as unknown as CqlLsProcess['lspClient'],
  };
  return process as CqlLsProcess;
}

function okResponse(patients: string[], extraExpressions?: Record<string, Record<string, string>>): ExecuteCqlResponse {
  return {
    results: patients.map((p) => ({
      libraryName: 'L',
      expressions: Object.entries(extraExpressions?.[p] ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    })),
    logs: [],
    versions: { languageServer: '4.10.0' },
  };
}

function crashedResponse(): Error {
  return new LanguageServerCrashedError({ exitCode: 137, signal: 'SIGKILL', stderrTail: ['killed'] });
}

describe('testPipeline/suiteRunner', () => {
  describe('runFile', () => {
    it('persists run and updates latest pointer on a single patient', async () => {
      const root = mkRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1'], { p1: { Measure: 'true' } })],
        ensureReadyCount: 0,
      };
      try {
        const cqlFile = path.join(root, 'L.cql');
        fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
        const run = await runFile({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          contextValues: ['p1'],
          fhirVersion: 'R4',
          suiteName: 'L',
        });
        expect(run.suiteName).to.equal('L');
        expect(run.cases).to.have.length(1);
        expect(run.cases[0].patientId).to.equal('p1');
        expect(run.cases[0].status).to.equal('passed');
        expect(state.ensureReadyCount).to.equal(1);
        const all = listRuns(root);
        expect(all).to.have.length(1);
        expect(readLatestPointer(root, 'L')?.hash).to.equal(run.hash);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('marks case failed when LS returns an Error expression', async () => {
      const root = mkRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [
          {
            results: [
              { libraryName: 'L', expressions: [{ name: 'Error', value: 'boom' }] },
            ],
            logs: [],
            versions: {},
          },
        ],
        ensureReadyCount: 0,
      };
      try {
        const cqlFile = path.join(root, 'L.cql');
        fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
        const run = await runFile({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          contextValues: ['p1'],
          suiteName: 'L',
        });
        expect(run.cases[0].status).to.equal('failed');
        expect(run.cases[0].errors).to.deep.equal(['boom']);
        expect(run.counts.failed).to.equal(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('passes a caller-supplied modelUri through as the data model', async () => {
      const root = fs.realpathSync(mkRoot());
      const state: MockProcessState = { calls: [], queue: [okResponse(['p1'])], ensureReadyCount: 0 };
      try {
        const cqlFile = path.join(root, 'L.cql');
        fs.writeFileSync(cqlFile, "library L version '1.0.0'");
        const data = path.join(root, 'p1');
        fs.mkdirSync(data);
        await runFile({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          contextValues: ['p1'],
          modelUri: data,
        });
        const request = state.calls[0]!.args[0] as ExecuteCqlRequest;
        expect(request.libraries[0]?.model).to.deep.equal({ modelName: 'FHIR', modelUri: pathToUri(data) });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('defaults suiteName to the CQL file stem', async () => {
      const root = mkRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1'])],
        ensureReadyCount: 0,
      };
      try {
        const cqlFile = path.join(root, 'MyLib.cql');
        fs.writeFileSync(cqlFile, 'library MyLib version "1.0.0"');
        const run = await runFile({ process: mkMockProcess(state), workspaceRoot: root }, { cqlFile, contextValues: ['p1'] });
        expect(run.suiteName).to.equal('MyLib');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('runSuite', () => {
    function mkSuiteRoot(): { root: string; cqlFile: string; suiteRoot: string; suiteName: string } {
      const root = mkRoot();
      const cqlFile = path.join(root, 'L.cql');
      fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
      const suiteName = 'L';
      // Layout A: suiteRoot is the parent dir that contains per-library subdirs.
      const suiteRoot = path.join(root, 'suites');
      fs.mkdirSync(suiteRoot, { recursive: true });
      const libraryDir = path.join(suiteRoot, suiteName);
      fs.mkdirSync(libraryDir, { recursive: true });
      fs.mkdirSync(path.join(libraryDir, 'shared'));
      fs.mkdirSync(path.join(libraryDir, 'p1'), { recursive: true });
      fs.mkdirSync(path.join(libraryDir, 'p2'), { recursive: true });
      return { root, cqlFile, suiteRoot, suiteName };
    }

    it('runs all discovered cases and skips "shared"', async () => {
      const { root, cqlFile, suiteRoot, suiteName } = mkSuiteRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1']), okResponse(['p2'])],
        ensureReadyCount: 0,
      };
      try {
        const run = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          suiteRoot,
          suiteName,
          fhirVersion: 'R4',
        });
        expect(run.cases.map((c) => c.patientId).sort()).to.deep.equal(['p1', 'p2']);
        expect(state.calls).to.have.length(2);
        expect(listRuns(root)).to.have.length(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('applies config.testCasesToExclude (union with caller-supplied)', async () => {
      const { root, cqlFile, suiteRoot, suiteName } = mkSuiteRoot();
      // Add a third 'excluded' directory so the config has something to filter.
      fs.mkdirSync(path.join(suiteRoot, suiteName, 'excluded'), { recursive: true });
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1'])],
        ensureReadyCount: 0,
      };
      try {
        const configPath = path.join(suiteRoot, 'config.jsonc');
        fs.writeFileSync(
          configPath,
          `// comments ok
          {
            "testCasesToExclude": [{ "testCase": "excluded" }],
          }`,
        );
        const run = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          suiteRoot,
          suiteName,
          configPath,
          excludeTestCases: ['p2'], // union should drop p2 too
        });
        expect(run.cases.map((c) => c.patientId)).to.deep.equal(['p1']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('on LS crash mid-run: errored case recorded, remaining cases skipped', async () => {
      const { root, cqlFile, suiteRoot, suiteName } = mkSuiteRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [crashedResponse()],
        ensureReadyCount: 0,
      };
      try {
        const run = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          suiteRoot,
          suiteName,
        });
        expect(run.cases).to.have.length(2);
        expect(run.cases[0].status).to.equal('errored');
        expect(run.cases[0].errors).to.deep.equal(['killed']);
        expect(run.cases[1].status).to.equal('skipped');
        expect(run.cases[1].reason).to.equal('language_server_crashed');
        expect(run.counts.errored).to.equal(1);
        expect(run.counts.skipped).to.equal(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("sends each case's folder as the model and the IG root as rootDir", async () => {
      // IG layout: <ig>/ig.ini, <ig>/input/cql/L.cql, <ig>/input/tests/L/{p1,p2}.
      const ig = fs.realpathSync(mkRoot());
      fs.writeFileSync(path.join(ig, 'ig.ini'), '[IG]\n');
      fs.mkdirSync(path.join(ig, 'input', 'cql'), { recursive: true });
      const cqlFile = path.join(ig, 'input', 'cql', 'L.cql');
      fs.writeFileSync(cqlFile, "library L version '1.0.0'");
      const suiteRoot = path.join(ig, 'input', 'tests');
      for (const p of ['p1', 'p2']) fs.mkdirSync(path.join(suiteRoot, 'L', p), { recursive: true });
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1']), okResponse(['p2'])],
        ensureReadyCount: 0,
      };
      try {
        await runSuite({ process: mkMockProcess(state), workspaceRoot: ig }, { cqlFile, suiteRoot, suiteName: 'L' });
        const requests = state.calls.map((c) => c.args[0] as ExecuteCqlRequest);
        expect(requests.map((r) => r.libraries[0]?.context?.contextValue)).to.deep.equal(['p1', 'p2']);
        expect(requests.map((r) => r.libraries[0]?.model)).to.deep.equal([
          { modelName: 'FHIR', modelUri: pathToUri(path.join(suiteRoot, 'L', 'p1')) },
          { modelName: 'FHIR', modelUri: pathToUri(path.join(suiteRoot, 'L', 'p2')) },
        ]);
        expect(requests.map((r) => r.rootDir)).to.deep.equal([pathToUri(ig), pathToUri(ig)]);
      } finally {
        fs.rmSync(ig, { recursive: true, force: true });
      }
    });

    it('lets an explicit rootDir override the derived IG root', async () => {
      const { root, cqlFile, suiteRoot, suiteName } = mkSuiteRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1']), okResponse(['p2'])],
        ensureReadyCount: 0,
      };
      try {
        await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          suiteRoot,
          suiteName,
          rootDir: root,
        });
        const requests = state.calls.map((c) => c.args[0] as ExecuteCqlRequest);
        expect(requests.map((r) => r.rootDir)).to.deep.equal([pathToUri(root), pathToUri(root)]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('empty suite yields a persisted empty run', async () => {
      const { root, cqlFile } = mkSuiteRoot();
      const state: MockProcessState = { calls: [], queue: [], ensureReadyCount: 0 };
      try {
        const emptySuiteRoot = path.join(root, 'empty-suites');
        fs.mkdirSync(emptySuiteRoot, { recursive: true });
        const run = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, {
          cqlFile,
          suiteRoot: emptySuiteRoot,
          suiteName: 'empty',
        });
        expect(run.cases).to.have.length(0);
        expect(run.counts.total).to.equal(0);
        expect(state.ensureReadyCount).to.equal(0); // ensureReady NOT called for empty
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('persists run and rotates pointer (timestamp differentiates identical-input runs)', async () => {
      const { root, cqlFile, suiteRoot, suiteName } = mkSuiteRoot();
      const state: MockProcessState = {
        calls: [],
        queue: [okResponse(['p1']), okResponse(['p2']), okResponse(['p1']), okResponse(['p2'])],
        ensureReadyCount: 0,
      };
      try {
        const runA = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, { cqlFile, suiteRoot, suiteName });
        // Force timestamp divergence between the two runs
        await new Promise((r) => setTimeout(r, 5));
        const runB = await runSuite({ process: mkMockProcess(state), workspaceRoot: root }, { cqlFile, suiteRoot, suiteName });
        expect(runA.timestamp).to.not.equal(runB.timestamp);
        expect(listRuns(root)).to.have.length(2);
        const latest = readLatestPointer(root, suiteName)?.hash;
        expect(latest).to.equal(runB.hash);
        // Both files exist on disk with distinct timestamps → plain accumulation
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
