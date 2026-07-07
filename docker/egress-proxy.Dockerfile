# Egress allowlist proxy image — ADR-005 / WP3b.5 workbench sidecar.
#
# Runs the dependency-free node proxy (egress-proxy.mjs) that forwards only
# allowlisted hosts. Sits between the workbench (on a Docker `--internal`
# network) and the outside, so the workbench's sole egress path is the
# declared allowlist. Non-root, no persisted state.

FROM node:22-slim

RUN useradd --create-home --uid 10002 egress
COPY egress-proxy.mjs /egress-proxy.mjs
USER egress

# Allowlist is supplied at run time: -e EGRESS_ALLOW=host1,host2
ENV EGRESS_ALLOW=""
CMD ["node", "/egress-proxy.mjs"]
