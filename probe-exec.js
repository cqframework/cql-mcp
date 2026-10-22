const { spawn } = require('node:child_process');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const java = process.env.JAVA_HOME + '/bin/java';
const jar = process.env.CQL_LS_JAR_PATH;
const child = spawn(java, ['-Xmx4g', '-Dlogback.configurationFile=' + process.env.LOGBACK_FILE, '-jar', jar, '-workspace', '/tmp/w'], { stdio: ['pipe','pipe','pipe'] });
child.stderr.pipe(process.stderr);
const conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
conn.listen();
const fileUri = 'file://' + process.env.FIXTURE;
(async () => {
  const res = await conn.sendRequest('initialize', { processId: process.pid, clientInfo: { name: 'probe' }, capabilities: {} });
  conn.sendNotification('initialized', {});
  const req = {
    fhirVersion: 'R4',
    rootDir: process.env.WORKSPACE,
    libraries: [{
      libraryName: 'BasicLibrary',
      libraryUri: 'file://' + process.env.FIXTURE_DIR,
      libraryVersion: null,
      terminologyUri: null,
      model: null,
      context: null,
      parameters: {}
    }]
  };
  const raw = await conn.sendRequest('workspace/executeCommand', { command: 'org.opencds.cqf.cql.ls.executeCql', arguments: [req] });
  console.log('RAW RESPONSE:', JSON.stringify(raw, null, 2).slice(0, 4000));
  child.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('ERR', e); child.kill('SIGKILL'); process.exit(1); });
