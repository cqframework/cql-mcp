const { spawn } = require('node:child_process');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const java = process.env.JAVA_HOME + '/bin/java';
const jar = process.env.CQL_LS_JAR_PATH;
const child = spawn(java, ['-Xmx4g', '-Dlogback.configurationFile=' + process.env.LOGBACK_FILE, '-jar', jar, '-workspace', '/tmp/w'], { stdio: ['pipe','pipe','pipe'] });
child.stderr.pipe(process.stderr);
const conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
conn.listen();
(async () => {
  await conn.sendRequest('initialize', { processId: process.pid, clientInfo: { name: 'probe' }, capabilities: {} });
  conn.sendNotification('initialized', {});
  const { buildExecuteCqlRequest } = require('./dist/src/tools/executeCqlTool.js');
  for (const [label, extra] of [['null-context', {}], ['patient-context', { contextValues: ['defaultPatient'] }]]) {
    const req = buildExecuteCqlRequest({ cqlFile: process.env.FIXTURE, ...extra });
    console.log('\n=== ' + label + ' request.libraries[0].context:', JSON.stringify(req.libraries[0].context));
    try {
      const raw = await conn.sendRequest('workspace/executeCommand', { command: 'org.opencds.cqf.cql.ls.executeCql', arguments: [req] });
      console.log(label, 'RAW:', JSON.stringify(raw, null, 1).slice(0, 2500));
    } catch (e) {
      console.log(label, 'ERR:', e.message);
    }
  }
  child.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error(e); child.kill('SIGKILL'); process.exit(1); });
