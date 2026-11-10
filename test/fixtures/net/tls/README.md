# Test-only TLS fixtures

`ca.pem` and `server.pem`/`server.key` exist only so the layer 2 network tests can run an HTTPS
fake repository that stands in for a corporate server with a private CA. **They are not secrets
and must never be used for anything else.** The CA's private key was discarded after signing.

To regenerate (ECDSA P-256, 100-year validity, SAN `IP:127.0.0.1` and `DNS:localhost`), create a
new CA, sign a new server certificate with it, and drop the CA key:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 36500 -subj "/CN=cql-mcp TEST CA (not for production)" \
  -out ca.pem -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl ecparam -name prime256v1 -genkey -noout -out server.key
openssl req -new -key server.key -subj "/CN=127.0.0.1" -out server.csr
printf "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 36500 -sha256 -out server.pem -extfile ext.cnf
rm ca.key server.csr ca.srl ext.cnf
```
