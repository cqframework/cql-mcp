FROM eclipse-temurin:17.0.13_11-jre-jammy AS jre

FROM node:22.11.0-bookworm-slim
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH

# The packed build under test, exactly as `npm publish` would ship it.
COPY .work/pkg/cql-mcp.tgz /tmp/cql-mcp.tgz
RUN npm i -g /tmp/cql-mcp.tgz && rm /tmp/cql-mcp.tgz

COPY run.mjs /e2e/run.mjs
# run.mjs refuses to run outside this image: it writes settings.xml and caches under HOME.
ENV E2E_IN_CONTAINER=1
